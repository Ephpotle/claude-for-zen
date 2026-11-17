#!/usr/bin/env node
// Claude for Zen — chat panel server.
//
// Serves a small chat page on localhost for Zen's AI chat sidebar and relays
// the conversation to a headless Claude Code process that has only the Zen
// browser tools. One conversation at a time; it survives the panel being
// closed and reopened.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { Conversation, THEMES, knownCommands } from './conversation.js';
import { ask, extractHtml, EXPLAIN_MODES } from './explain.js';
import { asDocument, createCardStore, sendCard } from '../server/cards.js';
import { addonAllowed } from '../server/pin.js';
import { userscriptStatus } from './userscripts.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.CLAUDE_FOR_ZEN_CHAT_PORT) || 47810;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Headless Claude Code runs from an empty folder so no project settings apply.
const workDir = path.join(process.env.CLAUDE_FOR_ZEN_HOME || path.join(os.homedir(), '.claude-for-zen'), 'chat');
mkdirSync(workDir, { recursive: true });

// The page gets this token in its HTML. Other websites can make requests to
// localhost but cannot read our responses, so they never learn it.
const token = randomBytes(24).toString('hex');
// The panel is also reachable as http://claude.localhost/ (browsers resolve
// *.localhost to this machine), which reads better than an IP address where
// Zen shows the provider's address.
const NAME = 'claude.localhost';
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, `http://${NAME}:${PORT}`, `http://${NAME}`]);
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, `${NAME}:${PORT}`, NAME]);

// One "seat" per panel that is open at the same time (one per browser window,
// usually). Each seat holds a conversation and its own Claude, so two windows
// can work in parallel. Seats are kept when their panel closes, so reopening
// the sidebar returns to the same conversation.
const MAX_SEATS = 4; // each running seat takes one of the add-on's five connections
const seats = [];
function makeSeat(resume) {
  const seat = new Conversation({ workDir, mcpServerPath: path.join(root, 'server', 'index.js'), model: process.env.CLAUDE_FOR_ZEN_MODEL, resume });
  seat.panels = 0;
  seat.touched = Date.now();
  seats.push(seat);
  setImmediate(() => watchForQuestions(seat)); // tellAddon is defined further down
  return seat;
}
makeSeat(true); // the first panel resumes where the last run left off
const byRecent = (a, b) => b.touched - a.touched;
const stored = (id) => seats[0].list().some((entry) => entry.id === id);

// Added to a drawing so the panel can fit its frame to the content: the frame
// is sandboxed, so the panel cannot measure it from outside.
const FIGURE_SIZER = `<script>(() => {
  const tell = () => parent.postMessage({ claudeForZenFigure: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)) }, '*');
  addEventListener('load', tell);
  addEventListener('resize', tell);
  new ResizeObserver(tell).observe(document.documentElement);
})();</script>`;

/** The HTML of a drawing in a conversation, whether that conversation is open or filed. */
function figureHtml(conversationId, itemId) {
  let history = seats.find((seat) => seat.id === conversationId)?.history;
  if (!history) {
    try {
      history = JSON.parse(readFileSync(path.join(seats[0].storeDir, conversationId + '.json'), 'utf8')).history;
    } catch {
      return null;
    }
  }
  const item = history.find((i) => i.id === itemId && i.type === 'figure');
  return item ? item.html : null;
}

/** The seat for a panel that just connected. `hint` is the conversation it showed before a reload. */
function seatFor(hint) {
  const same = hint && seats.find((seat) => seat.id === hint);
  if (same) return same;
  const free = seats.filter((seat) => seat.panels === 0).sort(byRecent);
  // A panel that knows its conversation gets it back, in a free seat or a new one.
  if (hint && stored(hint)) {
    const seat = free.find((s) => !s.busy) ?? (seats.length < MAX_SEATS ? makeSeat(false) : null);
    if (seat) {
      seat.open(hint);
      return seat;
    }
  }
  // Otherwise: the seat nobody is looking at, or a fresh one for a second window.
  if (free.length) return free[0];
  if (seats.length < MAX_SEATS) return makeSeat(false);
  return [...seats].sort(byRecent)[0];
}
/** Where a comment pinned on a page goes: the conversation of that window, else the panel the user touched last. */
const activeSeat = (windowId) => {
  const order = [...seats].sort((a, b) => (b.panels > 0) - (a.panels > 0) || byRecent(a, b));
  return (typeof windowId === 'number' && order.find((seat) => seat.windowId === windowId)) || order[0];
};

// A permission question is easy to miss when its conversation is in another
// window, or its panel is closed: say so in the other panels and on the add-on's
// toolbar button.
function watchForQuestions(seat) {
  seat.subscribe((event) => {
    // The list of slash commands is learned by whichever conversation starts first; every panel wants it.
    if (event.type === 'commands') {
      for (const other of seats) if (other !== seat) for (const fn of other.subscribers) fn(event);
      return;
    }
    const asked = event.type === 'item' && event.item.type === 'ask';
    if (!asked && event.type !== 'update' && event.type !== 'busy' && event.type !== 'reset') return;
    tellAddon({ type: 'attention', waiting: seats.filter((s) => s.history.some((i) => i.type === 'ask' && i.state === 'waiting')).length });
    if (!asked) return;
    const text = seat.panels ? 'A conversation in another window is waiting for your OK.' : 'A conversation with no open panel is waiting for your OK. Open it from History.';
    for (const other of seats) {
      if (other === seat) continue;
      for (const fn of other.subscribers) fn({ type: 'notice', text });
    }
  });
}

// The on-page Explain card favours a quick model; the panel conversation uses
// your default.
const explainModel = process.env.CLAUDE_FOR_ZEN_EXPLAIN_MODEL || 'sonnet';
const cards = createCardStore();

// The panel's own files. CLAUDE_FOR_ZEN_PUBLIC points at another folder with
// index.html, app.js and app.css, for trying out a different look.
const PUBLIC = process.env.CLAUDE_FOR_ZEN_PUBLIC || path.join(here, 'public');
const FILES = {
  '/markdown.js': [path.join(root, 'extension', 'markdown.js'), 'text/javascript'],
  '/app.js': [path.join(PUBLIC, 'app.js'), 'text/javascript'],
  '/app.css': [path.join(PUBLIC, 'app.css'), 'text/css'],
  '/icon.svg': [path.join(root, 'extension', 'icons', 'icon.svg'), 'image/svg+xml'],
};

const server = http.createServer(async (req, res) => {
  // Refuse requests addressed to any other name (DNS rebinding).
  if (!HOSTS.has(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (cards.handle(req, res)) return;
  // A drawing Claude put in the chat: /figure/<conversation>/<item>.
  const figure = /^\/figure\/([0-9a-f]{16})\/(i\d+)$/.exec((req.url || '').split('?')[0]);
  if (figure) {
    const html = figureHtml(figure[1], figure[2]);
    if (html === null) res.writeHead(404, { 'content-type': 'text/plain' }).end('This drawing is no longer available.');
    else sendCard(res, asDocument(html) + FIGURE_SIZER);
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (url.pathname === '/ping') {
    // Lets the add-on check the server is here before opening a WebSocket.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ app: 'claude-for-zen-chat' }));
    return;
  }
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://claude.localhost:* ws://claude.localhost; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors moz-extension:",
  };
  try {
    if (url.pathname === '/') {
      const html = (await readFile(path.join(PUBLIC, 'index.html'), 'utf8')).replace('__TOKEN__', token).replace('<html lang="en">', `<html lang="en" data-theme="${THEMES.includes(seats[0].settings.theme) ? seats[0].settings.theme : ''}">`);
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(html);
    } else if (FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      const body = await readFile(file);
      res.writeHead(200, { ...headers, 'content-type': `${type}; charset=utf-8` }).end(body);
    } else {
      res.writeHead(404, headers).end('Not found');
    }
  } catch (err) {
    res.writeHead(500, headers).end(String(err.message));
  }
});

// Two kinds of client, told apart at the WebSocket handshake:
//   /ws   the panel page: must come from this origin and carry the page token
//   /ext  the add-on: must come from an extension origin, which web pages cannot forge
const wss = new WebSocketServer({ noServer: true });
const extWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const refuse = () => {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
  };
  if (!HOSTS.has(req.headers.host)) return refuse();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return refuse();
  }
  const origin = req.headers.origin;
  if (url.pathname === '/ws' && ORIGINS.has(origin) && url.searchParams.get('token') === token) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (url.pathname === '/ext' && addonAllowed(origin)) {
    extWss.handleUpgrade(req, socket, head, (ws) => extWss.emit('connection', ws, req));
  } else {
    refuse();
  }
});

// The add-on also keeps one standing "control" connection open, so the panel
// can ask it to do something in the page (start comment mode).
const controls = new Set();
function tellAddon(event) {
  let told = false;
  for (const socket of controls) {
    if (socket.readyState !== socket.OPEN) continue;
    socket.send(JSON.stringify(event));
    told = true;
  }
  return told;
}

// Ask the add-on which tab the user is looking at. Asked at the moment they send
// a message, when the window they typed in is the one in front. An add-on too
// old to answer simply times out.
const asked = new Map();
let askId = 0;
function whereIsUser() {
  return new Promise((resolve) => {
    const id = ++askId;
    const finish = (answer) => {
      clearTimeout(timer);
      asked.delete(id);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), 700);
    asked.set(id, finish);
    if (!tellAddon({ type: 'where', id })) finish(null);
  });
}
// Pictures pasted into the panel: at most four, of the kinds Claude takes, each with a
// small preview that is kept with the conversation (the full picture is not).
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function pictures(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 4)
    .filter((p) => p && PICTURE_TYPES.includes(p.mediaType) && typeof p.data === 'string' && p.data.length < 7_000_000 && /^[A-Za-z0-9+/]+=*$/.test(p.data))
    .map((p) => ({
      mediaType: p.mediaType,
      data: p.data,
      preview: typeof p.preview === 'string' && p.preview.length < 80_000 && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(p.preview) ? p.preview : null,
    }));
}

const clipText = (value, n) => (String(value ?? '').length > n ? String(value).slice(0, n - 1) + '…' : String(value ?? ''));

// The browser has just started (or this server has): if userscripts are switched on and
// Violentmonkey is not connected, have the add-on open Violentmonkey's connect page, where
// the user presses Approve. Once per browser start, and never again if they leave it.
let lastOffer = 0;
async function offerUserscriptApproval(socket) {
  if (!seats[0].settings.scripts || Date.now() - lastOffer < 60_000) return;
  lastOffer = Date.now();
  const status = await userscriptStatus(path.dirname(seats[0].settingsFile));
  if (!status || status.connected || !status.connectUrl) return;
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'approve_userscripts', url: status.connectUrl }));
}

// Every other add-on connection serves one Explain card or one comment.
extWss.on('connection', (socket) => {
  const send = (event) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(event));
  let job = null;
  socket.on('error', () => {});
  socket.on('close', () => {
    job?.cancel();
    controls.delete(socket);
  });
  socket.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'control') {
      controls.add(socket);
      offerUserscriptApproval(socket);
      return;
    }
    if (msg.type === 'where') {
      asked.get(msg.id)?.(msg);
      return;
    }
    if (msg.type === 'comment') {
      if (typeof msg.comment !== 'string' || !msg.comment.trim()) return;
      const accepted = activeSeat(msg.windowId).comment(msg);
      send(accepted ? { type: 'comment_sent' } : { type: 'error', text: 'Claude is still working on the last request. Send this when it has finished, or stop it in the chat panel.' });
      return;
    }
    if (msg.type !== 'explain' || typeof msg.selection !== 'string' || !msg.selection.trim()) return;
    job?.cancel();
    const visual = msg.mode === 'visual';
    let mine;
    try {
      mine = job = ask({
        kind: visual ? 'visual' : 'explain',
        // Only the known modes: this value becomes part of a file name.
        mode: !visual && EXPLAIN_MODES.includes(msg.mode) ? msg.mode : 'default',
        request: msg,
        workDir,
        model: explainModel,
        onDelta: visual ? null : (text) => send({ type: 'delta', text }),
      });
    } catch (err) {
      send({ type: 'error', text: `Could not start Claude Code: ${err.message}` });
      return;
    }
    try {
      const reply = await mine.done;
      if (job !== mine) return;
      if (visual) {
        const html = extractHtml(reply);
        if (!html) throw new Error('Claude did not return a drawing this time. Try again.');
        send({ type: 'card', html, url: `http://${HOST}:${PORT}${cards.add(html)}` }); // url: for add-ons before 0.2.4
      } else {
        send({ type: 'done' });
      }
    } catch (err) {
      if (job === mine && err.message !== 'cancelled') send({ type: 'error', text: err.message });
    }
  });
});

wss.on('connection', (socket, req) => {
  const send = (event) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(event));
  let conversation = null;
  let unsubscribe = null;
  const attach = (seat) => {
    if (conversation) {
      unsubscribe();
      conversation.panels--;
    }
    conversation = seat;
    seat.panels++;
    seat.touched = Date.now();
    // Bring a reopened panel back to where the conversation stands.
    send({ type: 'history', events: seat.history, busy: seat.busy, settings: seat.settings, status: { ...seat.status, now: Date.now() }, commands: knownCommands(path.dirname(seat.settingsFile)), id: seat.id });
    unsubscribe = seat.subscribe(send);
  };
  /** Another seat holding this conversation: showing in a window, still working, or just kept. */
  const holder = (id) => seats.find((seat) => seat !== conversation && seat.id === id);
  const sendList = () => {
    // Conversations that are working have not all been saved yet; make sure they show.
    const listed = conversation.list();
    for (const seat of seats) if (seat.history.length && !listed.some((entry) => entry.id === seat.id)) seat.save();
    send({
      type: 'conversations',
      current: conversation.id,
      list: conversation.list().map((entry) => {
        const seat = seats.find((s) => s.id === entry.id);
        return { ...entry, elsewhere: !!seat && seat !== conversation && seat.panels > 0, working: !!seat && seat.busy };
      }),
    });
  };
  /**
   * Leave a conversation that is still working without stopping it: it carries on
   * in its own seat, and this panel moves to an idle seat (or a new one).
   */
  const stepAside = () => {
    if (!conversation.busy) return conversation;
    const seat = seats.filter((s) => s !== conversation && s.panels === 0 && !s.busy).sort(byRecent)[0] ?? (seats.length < MAX_SEATS ? makeSeat(false) : null);
    if (!seat) {
      send({ type: 'notice', text: `${MAX_SEATS} conversations are working at once, which is the most there can be. Wait for one to finish, or stop one.` });
      return null;
    }
    return seat;
  };
  attach(seatFor(new URL(req.url, 'http://x').searchParams.get('seat')));
  socket.on('close', () => {
    unsubscribe();
    conversation.panels--;
  });
  socket.on('error', () => {});
  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    conversation.touched = Date.now();
    if (msg.type === 'touch') return;
    if (msg.type === 'send' && typeof msg.text === 'string') {
      const text = msg.text.trim();
      const images = pictures(msg.images);
      if (!text && !images.length) return;
      const seat = conversation;
      if (seat.busy) return;
      whereIsUser().then((where) => {
        if (!where?.tab || /^\/[\w:-]+(\s|$)/.test(text)) return seat.send(text, text, images);
        // This conversation now belongs to that window: new tabs and comment mode go there.
        seat.windowId = where.tab.windowId;
        const note = `[Browser: when this was sent the user was looking at tab ${where.tab.tabId}, “${clipText(where.tab.title, 80)}” — ${clipText(where.tab.url, 200)}, in window ${where.tab.windowId}${where.windows > 1 ? ` (${where.windows} windows are open)` : ''}${where.tab.incognito ? ', a private window' : ''}.]`;
        seat.send(text ? `${note}\n\n${text}` : note, text, images);
      });
    }
    else if (msg.type === 'stop') conversation.stop();
    else if (msg.type === 'reset') {
      // New chat while Claude is working: the work carries on in the background.
      const seat = stepAside();
      if (!seat) return;
      if (seat !== conversation) {
        seat.reset();
        attach(seat);
        send({ type: 'notice', text: 'The other conversation is still working. You will find it under History.' });
      } else {
        conversation.reset();
      }
    }
    else if (msg.type === 'settings') {
      // Settings are shared by every window.
      if (conversation.configure(msg)) for (const seat of seats) if (seat !== conversation) seat.adopt(conversation.settings);
    }
    else if (msg.type === 'comment_mode') {
      if (!tellAddon({ type: 'comment_mode', windowId: conversation.windowId })) {
        send({ type: 'notice', text: 'The Claude for Zen add-on is not connected. Update it to 0.2.1 or later (about:addons, gear icon, Check for Updates).' });
      }
    } else if (msg.type === 'list') sendList();
    else if (msg.type === 'open' && /^[0-9a-f]{16}$/.test(msg.id)) {
      // A conversation that is open in another window is joined there, not opened twice.
      const other = holder(msg.id);
      if (other) return attach(other);
      // Switching away from a conversation that is still working leaves it working.
      const seat = stepAside();
      if (!seat) return;
      seat.open(msg.id);
      if (seat !== conversation) attach(seat);
    } else if (msg.type === 'delete' && /^[0-9a-f]{16}$/.test(msg.id)) {
      const other = holder(msg.id);
      if (other && other.panels > 0) send({ type: 'notice', text: 'That conversation is open in another window. Close it there first.' });
      else if ((other || conversation).id === msg.id && (other || conversation).busy) send({ type: 'notice', text: 'That conversation is still working. Stop it first.' });
      else (other || conversation).remove(msg.id);
      sendList();
    } else if ((msg.type === 'rename' || msg.type === 'archive') && /^[0-9a-f]{16}$/.test(msg.id)) {
      const changes = msg.type === 'rename' ? { title: String(msg.title ?? '') } : { archived: msg.archived === true };
      (seats.find((seat) => seat.id === msg.id) || conversation).amend(msg.id, changes);
      sendList();
    }
    else if (msg.type === 'answer' && typeof msg.id === 'string') conversation.answer(msg.id, msg.allow === true);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Claude for Zen chat is already running on http://${HOST}:${PORT}`);
    process.exit(0);
  }
  throw err;
});
server.listen(PORT, HOST, () => console.error(`Claude for Zen chat panel: http://${HOST}:${PORT}`));

// Port 80 as well, so the friendly address needs no port number. Best effort:
// if something else has the port, the numbered address still works.
if (!process.env.CLAUDE_FOR_ZEN_CHAT_PORT) {
  const plain = http.createServer((req, res) => server.emit('request', req, res));
  plain.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
  plain.on('error', () => console.error(`Port 80 is taken; use http://${NAME}:${PORT}/ instead of http://${NAME}/`));
  plain.listen(80, HOST, () => console.error(`Also at http://${NAME}/`));
}

// One bad request or a failed child process must not end every conversation.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

const shutdown = () => {
  for (const seat of seats) seat.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
