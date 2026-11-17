// Chat panel test: starts the chat server, holds a real conversation with
// Claude Code through it, and checks Claude used the browser. Needs a running
// Zen with the extension installed, and uses your Claude subscription.
//
// It opens (and closes) one tab in that browser.

import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47819; // not the real panel's port, so a running panel is left alone
const base = `http://127.0.0.1:${PORT}`;

const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<title>Kettle test page</title><h1>The heading is Marmalade</h1><button onclick="this.textContent=\'Pressed\'">Press me</button>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${site.address().port}/`;

const home = mkdtempSync(path.join(os.tmpdir(), 'claude-for-zen-test-'));
const sandbox = path.join(home, 'files');
mkdirSync(sandbox);

const chat = spawn(process.execPath, [path.join(root, 'chat/server.js')], {
  // Its own home folder, so the test never touches your real panel's settings.
  env: { ...process.env, CLAUDE_FOR_ZEN_CHAT_PORT: String(PORT), CLAUDE_FOR_ZEN_HOME: home },
  stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(detail).slice(0, 800)}`);
  if (!ok) failures++;
};

async function status(url, headers = {}) {
  const res = await fetch(url, { headers });
  return res.status;
}

try {
  const html = await (await fetch(base + '/')).text();
  const token = html.match(/name="token" content="([0-9a-f]+)"/)?.[1];
  check('page is served with a token', !!token, html.slice(0, 200));

  // The panel must not be reachable by other websites.
  const refused = (origin, tok) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${tok}`, { origin });
      ws.on('open', () => (ws.close(), resolve(false)));
      ws.on('error', () => resolve(true));
    });
  check('refuses another website\'s origin', await refused('https://evil.example', token));
  check('refuses a wrong token', await refused(base, 'nope'));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`, { origin: base });
  const items = new Map();
  let busy = false;
  let turnDone;
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === 'item') items.set(event.item.id, event.item);
    if (event.type === 'delta') items.get(event.id).text += event.text;
    if (event.type === 'update') Object.assign(items.get(event.id), event.patch);
    if (event.type === 'busy') {
      if (busy && !event.busy) turnDone?.();
      busy = event.busy;
    }
  });
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)));

  const turn = (text) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), 240_000);
      turnDone = () => (clearTimeout(timer), resolve());
      ws.send(JSON.stringify({ type: 'send', text }));
    });
  const said = () => [...items.values()].filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  const steps = () => [...items.values()].filter((i) => i.type === 'tool');
  const dump = () => JSON.stringify([...items.values()], null, 1);

  await turn(`Open ${pageUrl} in a new tab and tell me what its heading says.`);
  check('Claude used the browser', steps().some((s) => s.name === 'mcp__zen__tab_create' && s.state === 'done'), dump());
  check('Claude read the page', /marmalade/i.test(said()), dump());

  await turn('Press the button on that page, tell me what the button says afterwards, then close that tab.');
  check('second turn keeps context and clicks', steps().some((s) => s.name === 'mcp__zen__click' && s.state === 'done') && /pressed/i.test(said()), dump());
  check('steps are described in plain words', steps().every((s) => !s.label.startsWith('mcp__')), dump());
  check('tab closed', steps().some((s) => s.name === 'mcp__zen__tab_close' && s.state === 'done'), dump());

  // --- computer access ---------------------------------------------------
  const asks = () => [...items.values()].filter((i) => i.type === 'ask');
  const file = path.join(sandbox, 'note.txt');
  const writeRequest = `Write a file at ${file} containing exactly the word marmalade. Do not use the browser.`;

  await turn(writeRequest);
  check('browser-only mode cannot write files', !existsSync(file) && asks().length === 0, dump());

  ws.send(JSON.stringify({ type: 'settings', access: 'ask', folder: sandbox }));
  // Answer permission requests as they appear: refuse the first, allow later ones.
  let refuseNext = true;
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type !== 'item' || event.item.type !== 'ask') return;
    ws.send(JSON.stringify({ type: 'answer', id: event.item.id, allow: !refuseNext }));
    refuseNext = false;
  });
  await turn(writeRequest);
  check('ask mode asks before writing', asks().length >= 1 && asks()[0].title === 'Write this file?', dump());
  check('refusing keeps the file from being written', asks()[0]?.state === 'denied' && !existsSync(file), dump());

  await turn('I changed my mind: go ahead and write that file now.');
  check('allowing lets the file be written', asks().some((a) => a.state === 'allowed') && existsSync(file) && /marmalade/.test(readFileSync(file, 'utf8')), dump());

  ws.send(JSON.stringify({ type: 'settings', access: 'full', folder: sandbox }));
  const before = asks().length;
  const second = path.join(sandbox, 'second.txt');
  await turn(`Now write ${second} containing the word kettle.`);
  check('full mode writes without asking', asks().length === before && existsSync(second), dump());

  console.log('\nTrail:\n' + steps().map((s) => `  ${s.state.padEnd(7)} ${s.label}`).join('\n'));
  console.log('\nClaude said:\n' + said());
  ws.close();
} catch (err) {
  check('test run', false, err.stack);
} finally {
  chat.kill();
  site.close();
  setTimeout(() => rmSync(home, { recursive: true, force: true }), 300);
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  setTimeout(() => process.exit(failures ? 1 : 0), 500);
}
