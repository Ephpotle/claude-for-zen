// Test for the "Zen itself" option: the chat panel's Claude using the Zen
// Spaces and uBlock Origin tools of the firefox-devtools-mcp fork.
//
// Launches its own headless Zen on a throwaway profile with remote control on
// (Marionette port 2829, not the 2828 your own Zen uses), plus a chat server on
// a test port with its own settings folder, so it never touches the browser you
// are using. uBlock Origin is copied into the throwaway profile from
// UBLOCK_XPI, or from your Zen profile if it is installed there; without it the
// uBlock checks are skipped.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zenPath = process.env.ZEN_PATH || 'C:/Program Files/Zen Browser/zen.exe';
const PORT = 47819;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

const MARIONETTE = 2829;
if (await listening(MARIONETTE)) {
  console.error(`Something is already listening on port ${MARIONETTE}. Not running.`);
  process.exit(2);
}

const home = mkdtempSync(path.join(os.tmpdir(), 'claude-for-zen-test-'));
const profile = path.join(home, 'zen-profile');
mkdirSync(profile);
writeFileSync(
  path.join(profile, 'user.js'),
  ['zen.welcome-screen.seen', 'browser.shell.checkDefaultBrowser']
    .map((p, i) => `user_pref("${p}", ${i === 0});`)
    .concat('user_pref("remote.prefs.recommended", false);', `user_pref("marionette.port", ${MARIONETTE});`, 'user_pref("extensions.autoDisableScopes", 0);')
    .join('\n'),
);
// uBlock Origin for the throwaway profile.
const UBLOCK = 'uBlock0@raymondhill.net.xpi';
const findUblock = () => {
  if (process.env.UBLOCK_XPI) return process.env.UBLOCK_XPI;
  const profiles = path.join(process.env.APPDATA || '', 'zen', 'Profiles');
  if (!existsSync(profiles)) return null;
  return readdirSync(profiles).map((p) => path.join(profiles, p, 'extensions', UBLOCK)).find(existsSync) ?? null;
};
const ublockXpi = findUblock();
if (ublockXpi) {
  mkdirSync(path.join(profile, 'extensions'));
  copyFileSync(ublockXpi, path.join(profile, 'extensions', UBLOCK));
}

// A page on 127.0.0.1 that loads a script from "localhost": another host, so third-party.
const SITE = 47992;
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/third.js')) return res.writeHead(200, { 'content-type': 'text/javascript' }).end('document.title = "third ran";');
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>plain</title><p>Article</p><script src="http://localhost:${SITE}/third.js"></script>`);
});
await new Promise((resolve) => site.listen(SITE, '127.0.0.1', resolve));

const zen = spawn(zenPath, ['-no-remote', '-profile', profile, '--marionette', '--remote-debugging-port', '9223', '--headless', `http://127.0.0.1:${SITE}/`], {
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  stdio: 'ignore',
});
const chat = spawn(process.execPath, [path.join(root, 'chat/server.js')], {
  env: { ...process.env, CLAUDE_FOR_ZEN_CHAT_PORT: String(PORT), CLAUDE_FOR_ZEN_HOME: home, CLAUDE_FOR_ZEN_MARIONETTE_PORT: String(MARIONETTE), CLAUDE_FOR_ZEN_DEV_ONLY: '1' }, // DEV_ONLY: your installed add-on must not answer this test
  stdio: ['ignore', 'inherit', 'inherit'],
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500)}`);
  if (!ok) failures++;
};

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++, await sleep(500)) up = await listening(MARIONETTE);
  check('throwaway Zen is up with remote control', up);
  if (!up) throw new Error('Zen did not open the Marionette port');

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
      // Answer permission requests from the queue; default is to allow.
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
  const turn = (text) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), 240_000);
      turnDone = () => (clearTimeout(timer), resolve());
      ws.send(JSON.stringify({ type: 'send', text }));
    });
  const all = () => [...items.values()];
  const steps = () => all().filter((i) => i.type === 'tool');
  const asks = () => all().filter((i) => i.type === 'ask');
  const said = () => all().filter((i) => i.type === 'text').map((i) => i.text).join('\n');

  ws.send(JSON.stringify({ type: 'settings', access: 'browser', folder: '', spaces: true }));
  await sleep(300);

  await turn('Which Spaces do I have in Zen? Just list their names.');
  check('lists Spaces without asking', steps().some((s) => s.name === 'mcp__zenspaces__zen_list_spaces' && s.state === 'done') && asks().length === 0, all());
  check('the step reads plainly', steps().some((s) => s.label === 'Looked at your Spaces'), steps());
  check('duplicate page tools are hidden', !steps().some((s) => /zenspaces__(list_pages|new_page|navigate_page)/.test(s.name)), steps());

  answers = [false];
  await turn('Create a Space called Marmalade.');
  check('creating a Space asks first', asks().length === 1 && asks()[0].title === 'Create this Space in Zen?' && /Marmalade/.test(asks()[0].body), asks());
  check('refusing leaves it uncreated', asks()[0].state === 'denied', asks());

  await turn('OK, go ahead and create it now. Then tell me the full list of Space names.');
  check('allowing creates it', asks().some((a) => a.state === 'allowed') && /Marmalade/.test(said().split('\n').slice(-6).join('\n')), all());

  ws.send(JSON.stringify({ type: 'settings', access: 'full', folder: '', spaces: true }));
  await sleep(300);
  const before = asks().length;
  await turn('Create one more Space called Kettle.');
  check('"without asking" still asks before changing Zen', asks().length === before + 1, asks());

  // Split view: arranging pages is as harmless as opening a tab, so it does not ask.
  ws.send(JSON.stringify({ type: 'settings', access: 'browser', folder: '', spaces: true }));
  await sleep(300);
  const asksBeforeSplit = asks().length;
  await turn('Show https://example.com/ and https://example.org/ next to each other in a split view, then tell me which tabs are sharing the screen.');
  const splitDone = steps().filter((s) => s.name === 'mcp__zenspaces__zen_split_view' && s.state === 'done');
  check('opens a split view without asking', splitDone.length === 1 && asks().length === asksBeforeSplit && /example.org/.test(said().slice(-800)), all().slice(-6));

  if (!ublockXpi) {
    console.log('SKIP  uBlock checks (uBlock Origin xpi not found; set UBLOCK_XPI)');
  } else {
    ws.send(JSON.stringify({ type: 'settings', access: 'browser', folder: '', spaces: true }));
    await sleep(300);
    const done = (tool) => steps().filter((s) => s.name === 'mcp__zenspaces__' + tool && s.state === 'done');
    let count = asks().length;
    await turn('What is uBlock Origin doing on the page in the front tab? Which hosts did it contact?');
    check('reads uBlock status without asking', done('ublock_status').length > 0 && asks().length === count && /127\.0\.0\.1/.test(said().slice(-1500)), all().slice(-6));

    await turn('Use uBlock to block all JavaScript on that site and reload it. Do not keep the change.');
    const ask = asks().at(-1);
    check('a uBlock switch asks first, in plain words', asks().length === count + 1 && /no-scripting/.test(ask.title) && /JavaScript on the site is blocked/.test(ask.body) && /Temporary/.test(ask.body), asks().slice(-2));
    check('allowed, the switch is set', ask.state === 'allowed' && done('ublock_set_switch').length === 1, steps().slice(-5));

    count = asks().length;
    answers = [false];
    await turn('Now block the host "localhost" on that site with a uBlock rule. If uBlock needs its advanced mode for that, switch it on.');
    check('advanced mode asks, and a refusal is respected', asks().length >= count + 1 && asks()[count].state === 'denied' && done('ublock_set_rule').length === 0, asks().slice(-3));

    await turn('OK, you may switch advanced mode on and set that rule. Reload the page, then tell me how many requests to localhost were blocked.');
    check('with advanced mode on, the rule is set', done('ublock_set_advanced_mode').length === 1 && done('ublock_set_rule').length === 1, steps().slice(-8));
  }

  console.log('\nTrail:\n' + steps().map((s) => `  ${s.state.padEnd(7)} ${s.label}`).join('\n'));
  console.log('\nClaude said (end):\n' + said().slice(-500));
  ws.close();
} catch (err) {
  check('test run', false, err.stack);
} finally {
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  chat.kill();
  site.close();
  // Stop only the browser this test started, found by its throwaway profile.
  if (process.platform === 'win32') {
    const marker = path.basename(home);
    const script = `Get-CimInstance Win32_Process -Filter "Name='zen.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  } else {
    zen.kill();
  }
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  }, 1500);
}
