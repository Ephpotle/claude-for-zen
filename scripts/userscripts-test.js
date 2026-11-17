// Test for the "Violentmonkey userscripts" option: the chat panel's Claude
// saving a page change as a userscript through Violentmonkey's own agent server.
//
// Launches a throwaway headless Zen (Marionette port 2829, not your own Zen's
// 2828) with Violentmonkey installed, a chat server on a test port with its own
// settings folder, and a small local page. Plays the user's part: opens the
// connect address, presses Approve in Violentmonkey, answers the panel's
// permission prompts. Needs:
//   - a Violentmonkey .xpi (2.50+): VIOLENTMONKEY_XPI, or one installed in your Zen profile
//   - the firefox-devtools-mcp fork built (see README), to press buttons in the browser

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zenPath = process.env.ZEN_PATH || 'C:/Program Files/Zen Browser/zen.exe';
const forkEntry = process.env.CLAUDE_FOR_ZEN_SPACES_MCP || path.resolve(root, '..', 'zen', 'firefox-devtools-mcp', 'dist.moz', 'index.js');
const PORT = 47817;
const VM_PORT = 47813;
const SITE = 47993;
const MARIONETTE = 2829;
const VM_XPI = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}.xpi';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

const findXpi = () => {
  if (process.env.VIOLENTMONKEY_XPI) return process.env.VIOLENTMONKEY_XPI;
  const profiles = path.join(process.env.APPDATA || '', 'zen', 'Profiles');
  if (!existsSync(profiles)) return null;
  return readdirSync(profiles).map((p) => path.join(profiles, p, 'extensions', VM_XPI)).find(existsSync) ?? null;
};
const xpi = findXpi();
if (!xpi || !existsSync(xpi)) {
  console.error('No Violentmonkey .xpi found. Set VIOLENTMONKEY_XPI to a downloaded copy (2.50 or newer).');
  process.exit(2);
}
if (await listening(MARIONETTE)) {
  console.error(`Something is already listening on port ${MARIONETTE}. Not running.`);
  process.exit(2);
}

const home = mkdtempSync(path.join(os.tmpdir(), 'claude-for-zen-test-'));
const profile = path.join(home, 'zen-profile');
mkdirSync(path.join(profile, 'extensions'), { recursive: true });
copyFileSync(xpi, path.join(profile, 'extensions', VM_XPI));
writeFileSync(
  path.join(profile, 'user.js'),
  [
    'user_pref("zen.welcome-screen.seen", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("remote.prefs.recommended", false);',
    `user_pref("marionette.port", ${MARIONETTE});`,
    'user_pref("extensions.autoDisableScopes", 0);',
  ].join('\n'),
);

const site = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Article</title><h1>Headline</h1><p>Body text.</p>'));
await new Promise((resolve) => site.listen(SITE, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${SITE}/`;

const zen = spawn(zenPath, ['-no-remote', '-profile', profile, '--marionette', '--remote-debugging-port', '9223', '--headless', pageUrl], {
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  stdio: 'ignore',
});
const chat = spawn(process.execPath, [path.join(root, 'chat/server.js')], {
  env: { ...process.env, CLAUDE_FOR_ZEN_CHAT_PORT: String(PORT), CLAUDE_FOR_ZEN_HOME: home, CLAUDE_FOR_ZEN_VM_PORT: String(VM_PORT), CLAUDE_FOR_ZEN_DEV_ONLY: '1' }, // DEV_ONLY: your installed add-on must not answer this test
  stdio: ['ignore', 'inherit', 'inherit'],
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500)}`);
  if (!ok) failures++;
};

let browser = null;
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++, await sleep(500)) up = await listening(MARIONETTE);
  if (!up) throw new Error('Zen did not open the Marionette port');

  // Hands in the browser: run a function with browser privileges.
  browser = new Client({ name: 'userscripts-test', version: '0' });
  await browser.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [forkEntry, '--connect-existing', '--marionette-port', String(MARIONETTE), '--tool-preset', 'mozilla'],
      env: { ...process.env, NODE_ENV: 'production' },
      stderr: 'ignore',
    }),
  );
  const text = (r) => r.content.map((c) => c.text).join('\n');
  const contexts = text(await browser.callTool({ name: 'list_privileged_contexts', arguments: {} }));
  const context = contexts.match(/([0-9a-f-]{36})[^\n]*browser\.xhtml/i)?.[1] ?? contexts.match(/browser\.xhtml[^\n]*?([0-9a-f-]{36})/i)?.[1];
  if (!context) throw new Error('No browser window context: ' + contexts);
  const inBrowser = async (fn) => {
    const out = text(await browser.callTool({ name: 'evaluate_privileged_script', arguments: { function: fn, context } }));
    const json = out.match(/```json\n([\s\S]*)\n```/)?.[1];
    if (json === undefined) throw new Error(out);
    return JSON.parse(JSON.parse(json));
  };
  // Runs `body` (a function source using `content`) inside the selected tab's page and returns its result.
  const inTab = (body) =>
    inBrowser(`async () => {
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      const mm = w.gBrowser.selectedBrowser.messageManager;
      const name = 'cfz-test:' + Date.now() + Math.random();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer from the tab')), 8000);
        mm.addMessageListener(name, function on(m) { mm.removeMessageListener(name, on); clearTimeout(timer); resolve(m.data); });
        mm.loadFrameScript('data:,' + encodeURIComponent('sendAsyncMessage(' + JSON.stringify(name) + ', JSON.stringify((' + ${JSON.stringify(body)} + ')()))'), false);
      });
    }`);
  const openTab = (url) =>
    inBrowser(`async () => {
      const w = Services.wm.getMostRecentWindow('navigator:browser');
      w.gBrowser.selectedTab = w.gBrowser.addTrustedTab(${JSON.stringify(url)});
      await new Promise((r) => w.setTimeout(r, 2500));
      return JSON.stringify(w.gBrowser.selectedBrowser.currentURI.spec);
    }`);

  // The panel.
  const html = await (await fetch(base + '/')).text();
  const token = html.match(/name="token" content="([0-9a-f]+)"/)[1];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`, { origin: base });
  const items = new Map();
  let busy = false;
  let turnDone;
  let answers = [];
  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === 'item') {
      items.set(event.item.id, event.item);
      if (event.item.type === 'ask') ws.send(JSON.stringify({ type: 'answer', id: event.item.id, allow: answers.length ? answers.shift() : true }));
    }
    if (event.type === 'delta') items.get(event.id).text += event.text;
    if (event.type === 'update') Object.assign(items.get(event.id), event.patch);
    if (event.type === 'busy') {
      if (busy && !event.busy) turnDone?.();
      busy = event.busy;
    }
  });
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)));
  const turn = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), 240_000);
      turnDone = () => (clearTimeout(timer), resolve());
      ws.send(JSON.stringify({ type: 'send', text: message }));
    });
  const all = () => [...items.values()];
  const VM = 'mcp__violentmonkey__';
  const done = (tool) => all().filter((i) => i.type === 'tool' && i.name === VM + tool && i.state === 'done');
  const asks = () => all().filter((i) => i.type === 'ask');
  const said = () => all().filter((i) => i.type === 'text').map((i) => i.text).join('\n');

  ws.send(JSON.stringify({ type: 'settings', access: 'browser', folder: '', scripts: true }));
  await sleep(300);

  await turn('Is Violentmonkey connected? Check, and just tell me yes or no. Do not open any tabs.');
  check('checks the connection without asking, and it is not connected yet', done('vm_status').length === 1 && asks().length === 0 && /\bno\b/i.test(said()), all());

  // The user's part: open the connect address, press Approve.
  const vmToken = readFileSync(path.join(home, 'violentmonkey-token'), 'utf8').trim();
  const landed = await openTab(`https://violentmonkey.github.io/mcp_connect.html?port=${VM_PORT}&token=${vmToken}`);
  check('the connect address lands on Violentmonkey’s settings', /^moz-extension:.*#settings\/mcp/.test(landed), landed);
  const pressed = await inTab(`function () {
    const button = [...content.document.querySelectorAll('.vm-mcp button')][0];
    if (!button) return 'no button: ' + content.document.body.textContent.slice(0, 200);
    button.click();
    return button.textContent;
  }`);
  check('Approve is pressed', /approve/i.test(pressed), pressed);
  await sleep(2000);

  answers = [false];
  await turn(`Write a userscript for ${pageUrl} that gives the page body a light yellow background (#ffffcc), and save it in Violentmonkey.`);
  const first = asks()[0];
  check('saving a script asks first', !!first && /Save the userscript/.test(first.title) && first.body.includes(`127.0.0.1:${SITE}`) && /==UserScript==/.test(first.body), asks());
  check('refusing saves nothing', first?.state === 'denied' && done('scripts_write').length === 0, all().slice(-5));

  await turn('OK, go ahead and save it now.');
  check('allowed, the script is saved', done('scripts_write').length === 1 && asks().at(-1).state === 'allowed', all().slice(-6));

  await inBrowser(`async () => {
    const w = Services.wm.getMostRecentWindow('navigator:browser');
    w.gBrowser.selectedTab = w.gBrowser.addTrustedTab(${JSON.stringify(pageUrl)});
    await new Promise((r) => w.setTimeout(r, 3000));
    return JSON.stringify(true);
  }`);
  const colour = await inTab('function () { return content.getComputedStyle(content.document.body).backgroundColor; }');
  check('the script runs on a fresh visit to the page', colour === 'rgb(255, 255, 204)', colour);

  // Update without asking: same pages, so no prompt; a wider script asks again.
  ws.send(JSON.stringify({ type: 'settings', scriptUpdates: true }));
  await sleep(300);
  let before = asks().length;
  await turn('Change that script so the background is light blue (#cce5ff) instead. Keep everything else the same.');
  check('an update on the same pages goes through without asking', asks().length === before && done('scripts_write').length === 2, all().slice(-6));
  answers = [false];
  await turn('Now change the same script so it also runs on https://example.com/*.');
  check('widening where it runs asks again', asks().length === before + 1 && /example.com/.test(asks().at(-1).body) && done('scripts_write').length === 2, all().slice(-6));

  const count = asks().length;
  await turn('Now switch that script off.');
  check('switching it off asks and is done', asks().length === count + 1 && done('scripts_set_enabled').length === 1, all().slice(-5));

  console.log('\nTrail:\n' + all().filter((i) => i.type === 'tool').map((s) => `  ${s.state.padEnd(7)} ${s.label}`).join('\n'));
  console.log('\nFirst prompt:\n' + first?.title + '\n' + first?.body);
  ws.close();
} catch (err) {
  check('test run', false, err.stack);
} finally {
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  await browser?.close().catch(() => {});
  chat.kill();
  site.close();
  if (process.platform === 'win32') {
    const marker = path.basename(home);
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  } else {
    zen.kill();
  }
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  }, 1500);
}
