// WebSocket bridge between this MCP server and the browser extension.
//
// Each MCP server (one per Claude Code session) takes the first free port in
// a small fixed range. The extension polls the whole range and connects to
// every server it finds, so several sessions can share one browser.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createCardStore } from './cards.js';
import { addonAllowed } from './pin.js';

export const HOST = '127.0.0.1';
export const BASE_PORT = Number(process.env.CLAUDE_FOR_ZEN_PORT) || 47800;
export const PORT_COUNT = 10; // keep in step with the add-on's background.js
const BUSY = 4001; // close code: this session already has a browser

const log = (...args) => console.error('[claude-for-zen]', ...args);

export class Bridge {
  constructor() {
    this.wss = null;
    this.port = null;
    this.socket = null; // the connected extension
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.nextId = 1;
    this.waiters = []; // callbacks waiting for an extension to connect
    this.cards = createCardStore(); // generated HTML shown on pages
  }

  async listen() {
    for (let i = 0; i < PORT_COUNT; i++) {
      const port = BASE_PORT + i;
      try {
        this.wss = await startServer(port, this.cards);
        this.port = port;
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    if (!this.wss) {
      log(`no free port in ${BASE_PORT}-${BASE_PORT + PORT_COUNT - 1}; too many sessions open`);
      return;
    }
    log(`waiting for the Zen extension on ws://${HOST}:${this.port}`);
    this.wss.on('connection', (socket) => this.admit(socket));
  }

  /**
   * Development aid: with CLAUDE_FOR_ZEN_DEV_ONLY set, only a temporarily
   * loaded add-on (web-ext run) is accepted, so tests drive the throwaway
   * browser and never the one you use day to day.
   */
  admit(socket) {
    if (!process.env.CLAUDE_FOR_ZEN_DEV_ONLY) return this.attach(socket);
    socket.on('error', () => {});
    const timer = setTimeout(() => socket.close(BUSY, 'no hello'), 3000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      let reply = {};
      try {
        reply = JSON.parse(data.toString());
      } catch {}
      if (reply.result && reply.result.development) this.attach(socket);
      else socket.close(BUSY, 'this session only accepts a development install');
    });
    socket.send(JSON.stringify({ id: 0, method: 'hello', params: {} }));
  }

  attach(socket) {
    // One browser per session. A second browser running the extension (another
    // profile, say) is turned away rather than fighting the first for control.
    if (this.socket) {
      socket.close(BUSY, 'another browser is already connected to this session');
      return;
    }
    this.socket = socket;
    log('extension connected');
    for (const wake of this.waiters.splice(0)) wake();

    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error !== undefined) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      log('extension disconnected');
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('The Zen extension disconnected before replying.'));
        this.pending.delete(id);
      }
    });
    socket.on('error', () => {});
  }

  /** Wait briefly for the extension; it polls every few seconds. */
  waitForExtension(ms = 8000) {
    if (this.socket) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, ms);
      this.waiters.push(wake);
    });
  }

  async call(method, params = {}, timeout = 30_000) {
    if (!this.wss) {
      throw new Error(
        `Claude for Zen could not open a local port (${BASE_PORT}-${BASE_PORT + PORT_COUNT - 1} are all in use). Close other Claude Code sessions and retry.`,
      );
    }
    if (!(await this.waitForExtension())) {
      throw new Error(
        'Zen is not connected. Make sure Zen Browser is running and the "Claude for Zen" extension is installed and enabled, then try again.',
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`"${method}" timed out after ${Math.round(timeout / 1000)}s.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Host a generated HTML document; returns the URL the extension can frame. */
  addCard(html) {
    if (!this.port) throw new Error("Claude for Zen has no local port open, so it can't host a card.");
    return `http://${HOST}:${this.port}${this.cards.add(html)}`;
  }

  close() {
    this.socket?.close();
    this.wss?.close();
  }
}

function startServer(port, cards) {
  return new Promise((resolve, reject) => {
    // Plain HTTP answers the extension's "is anyone there?" probe. The
    // extension only opens a WebSocket after a probe succeeds, because Firefox
    // delays reconnects (up to a minute) to ports where WebSockets keep failing.
    const httpServer = http.createServer((req, res) => {
      if (cards.handle(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ app: 'claude-for-zen' }));
    });
    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: 64 * 1024 * 1024,
      // Only a browser extension may connect. Web pages cannot forge Origin,
      // so a site you visit can't pose as the browser.
      // Web pages cannot send an extension origin, and of the installed add-ons only ours is accepted.
      verifyClient: ({ origin }) => addonAllowed(origin),
    });
    wss.on('error', () => {});
    httpServer.once('error', reject);
    httpServer.listen(port, HOST, () => {
      const close = wss.close.bind(wss);
      wss.close = () => {
        close();
        httpServer.close();
        httpServer.closeAllConnections();
      };
      resolve(wss);
    });
  });
}
