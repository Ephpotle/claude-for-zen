// End-to-end test for everything drawn on the page: marks, cards, the Explain
// button and comment pins. Launches a throwaway Zen with the add-on, and its
// own chat server (with its own settings folder) on the test port 47820, which
// only a temporarily loaded copy of the add-on looks for. Your own chat server
// and panel are left alone. Uses your Claude subscription for a few short requests.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

process.env.CLAUDE_FOR_ZEN_DEV_ONLY = '1'; // only the throwaway browser may connect
const { Bridge } = await import('../server/bridge.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zenPath = process.env.ZEN_PATH || 'C:/Program Files/Zen Browser/zen.exe';
const CHAT_PORT = 47820;
const CHAT = `http://127.0.0.1:${CHAT_PORT}`;
const shots = process.env.SHOTS_DIR || path.join(root, 'scripts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await fetch(CHAT + '/ping');
  console.error(`Something is already running on ${CHAT_PORT}. Stop it first, then run this test.`);
  process.exit(2);
} catch {}

const ARTICLE = `<!doctype html><html><head><title>How leaves make sugar</title>
<meta http-equiv="Content-Security-Policy" content="CSP_PLACEHOLDER">
<style>body{font:17px/1.6 Georgia,serif;max-width:640px;margin:40px auto;padding:0 20px}button{font:inherit}</style></head><body>
<h1>How leaves make sugar</h1>
<p id="p1">Plants feed themselves through <span id="term">photosynthesis</span>: inside each leaf, chlorophyll absorbs sunlight and uses that energy to combine water with carbon dioxide into glucose, releasing oxygen as a by-product.</p>
<p>The gas exchange happens through tiny pores called stomata, which open and close to balance taking in carbon dioxide against losing water.</p>
<button id="press" onclick="this.textContent='Pressed'">Press me</button>
<div style="height:1200px"></div></body></html>`;

const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(ARTICLE.replace('CSP_PLACEHOLDER', req.url === '/strict' ? "default-src 'none'; style-src 'unsafe-inline'" : "default-src * 'unsafe-inline' 'unsafe-eval'"));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const home = mkdtempSync(path.join(os.tmpdir(), 'claude-for-zen-test-'));
const chat = spawn(process.execPath, [path.join(root, 'chat/server.js')], {
  env: { ...process.env, CLAUDE_FOR_ZEN_HOME: home, CLAUDE_FOR_ZEN_CHAT_PORT: String(CHAT_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const webExt = spawn(
  process.execPath,
  [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'run', '--source-dir', path.join(root, 'extension'), '--firefox', zenPath, '--no-input', '--no-reload', '--pref', 'zen.welcome-screen.seen=true', '--pref', 'browser.shell.checkDefaultBrowser=false'],
  { stdio: 'ignore' },
);

const bridge = new Bridge();
await bridge.listen();

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
  if (!ok) failures++;
};
const attempt = async (method, params) => {
  try {
    return { ok: true, value: await bridge.call(method, params, 60000) };
  } catch (err) {
    return { ok: false, value: err.message };
  }
};

try {
  let connected = false;
  for (let i = 0; i < 8 && !connected; i++) connected = await bridge.waitForExtension(8000);
  check('throwaway browser connects (and only it)', connected);
  if (!connected) throw new Error('no browser');

  const tab = await bridge.call('tab_create', { url: base + '/' });
  const tabId = tab.tabId;
  const page = (action, params = {}) => bridge.call('page_action', { tabId, action, params });
  const state = () => page('overlay_state');
  const shot = async (name) => {
    const s = await bridge.call('screenshot', { tabId });
    writeFileSync(path.join(shots, `overlay-${name}.jpg`), Buffer.from(s.data, 'base64'));
  };
  const until = async (test, seconds) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(700)) {
      const s = await state();
      if (test(s)) return s;
    }
    return state();
  };

  // --- marks ----------------------------------------------------------------
  const found = await bridge.call('find', { tabId, query: '#press' });
  const ref = found.match(/ref=(e\d+)/)[1];
  let out = await bridge.call('annotate', {
    tabId,
    marks: [
      { ref, label: 'This is the button' },
      { text: 'tiny pores called   STOMATA', label: 'Stomata' },
      { text: 'this sentence is not on the page' },
    ],
  });
  let s = await state();
  check('annotate marks an element and a passage', s.marks.length === 2 && s.marks.every((m) => m.boxes >= 1), { out, s });
  check('annotate reports text it could not find', /Could not find/.test(out), out);
  await shot('marks');
  out = await bridge.call('clear_annotations', { tabId });
  check('clear_annotations', (await state()).marks.length === 0 && /Removed 2/.test(out), out);

  // --- selection ------------------------------------------------------------
  await bridge.call('javascript', { tabId, code: 'getSelection().selectAllChildren(document.getElementById("term")); document.dispatchEvent(new MouseEvent("mouseup", {bubbles: true})); 1' });
  out = await bridge.call('get_selection', { tabId });
  check('get_selection returns the selection and its context', /photosynthesis/.test(out) && /chlorophyll/.test(out), out);

  // --- card -----------------------------------------------------------------
  const cardHtml = '<style>body{margin:0;display:grid;place-items:center;height:100vh;font:20px system-ui;background:#135;color:#fff}</style><div id="x">card</div><script>document.getElementById("x").textContent="card script ran"</script>';
  out = await bridge.call('show_card', { tabId, html: cardHtml, title: 'Test card', width: 300, height: 160 });
  s = await state();
  check('show_card opens a card with a frame', s.cards.length === 1 && s.cards[0].title === 'Test card' && s.cards[0].frames === 1, { out, s });
  check('show_card confirms the content drew', /drew its content/.test(out) && !/Warning/.test(out), out);
  // Inline scripts and on* handlers run; the card has none of the add-on's powers.
  const lively = '<div id="x" onclick="this.textContent=1"></div><script>if (typeof browser !== "undefined" || typeof chrome !== "undefined") throw new Error("HAS_ADDON_API"); document.addEventListener("DOMContentLoaded", () => { document.getElementById("x").textContent = "ready"; });</script>';
  out = await bridge.call('show_card', { tabId, html: lively, title: 'Second card' });
  s = await state();
  check('a new card replaces the earlier one, and its scripts run without add-on powers', s.cards.length === 1 && s.cards[0].title === 'Second card' && /replaced 1 earlier card/.test(out) && !/Warning/.test(out), { out, s });
  out = await bridge.call('show_card', { tabId, html: '<script>document.body.textContent = ""; nope()</script>', title: 'Broken', keep: true });
  s = await state();
  check('a card that draws nothing says so', s.cards.length === 2 && /looks empty/.test(out) && /nope/.test(out), { out, s });
  out = await bridge.call('close_cards', { tabId });
  check('close_cards removes them', /Closed 2 cards/.test(out) && (await state()).cards.length === 0, out);
  // A hostile page frames the card page itself, WITHOUT the sandbox, and feeds it a script.
  // It must do nothing: unsandboxed it would run with the add-on's identity.
  const cardPage = (await bridge.call('hello')).base + 'card.html#x';
  const hostile = `new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = ${JSON.stringify(cardPage)};
    const payload = '<script>parent.postMessage({ escaped: self.origin + " " + typeof browser }, "*")</' + 'script>';
    const feed = () => frame.contentWindow.postMessage({ claudeForZenCard: 'x', html: payload }, '*', [new MessageChannel().port2]);
    const timer = setTimeout(() => resolve('refused'), 3000);
    window.addEventListener('message', (event) => {
      if (event.data && event.data.escaped) { clearTimeout(timer); resolve('RAN: ' + event.data.escaped); }
      else if (event.source === frame.contentWindow) feed();
    });
    frame.onload = feed;
    document.body.append(frame);
  })`;
  const escape = await attempt('javascript', { tabId, code: hostile });
  check('the card page refuses to run when a website frames it without the sandbox', escape.ok && /refused/.test(escape.value) && !/RAN/.test(escape.value), escape);

  // On a public website: the browser refuses frames from 127.0.0.1 there, which used to leave cards blank.
  const publicTab = await attempt('tab_create', { url: 'https://example.com/' });
  if (publicTab.ok && /example/i.test(publicTab.value.url)) {
    const shown = await attempt('show_card', { tabId: publicTab.value.tabId, html: cardHtml, title: 'Public page card' });
    check('a card draws on a public https page', shown.ok && /drew its content/.test(shown.value) && !/Warning/.test(shown.value), shown);
    await bridge.call('tab_close', { tabId: publicTab.value.tabId });
  } else {
    console.log('SKIP  card on a public page (example.com not reachable)');
  }
  out = await bridge.call('show_card', { tabId, html: cardHtml, title: 'Test card', width: 300, height: 160 });
  await sleep(1200);
  await shot('card');
  await bridge.call('key', { tabId, key: 'Escape' });
  check('Escape closes the card', (await state()).cards.length === 0);

  // --- explain --------------------------------------------------------------
  s = await until((x) => x.explainButton, 5);
  check('Explain button appears beside a selection', s.explainButton, s);
  await page('overlay_click', { text: 'Explain' });
  s = await until((x) => x.cards[0] && x.cards[0].buttons.some((b) => !b.disabled), 90);
  const answer = s.cards[0] ? s.cards[0].text : '';
  check('Explain card streams an answer', answer.length > 80 && !/Thinking…$/.test(answer) && !/not running|stopped unexpectedly/.test(answer), s);
  console.log('      explanation: ' + answer.slice(0, 260));
  await shot('explain');

  await page('overlay_click', { text: 'Show it visually' });
  s = await until((x) => x.cards[0] && x.cards[0].frames === 1, 180);
  check('Show it visually adds a drawing', s.cards[0] && s.cards[0].frames === 1, s);
  await sleep(2500);
  await shot('visual');
  await bridge.call('key', { tabId, key: 'Escape' });

  // --- comment pin ----------------------------------------------------------
  const html = await (await fetch(CHAT + '/')).text();
  const token = html.match(/name="token" content="([0-9a-f]+)"/)[1];
  const panel = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/ws?token=${token}`, { origin: CHAT });
  const items = new Map();
  let turnEnded = false;
  panel.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === 'item') items.set(event.item.id, event.item);
    if (event.type === 'delta') items.get(event.id).text += event.text;
    if (event.type === 'update') Object.assign(items.get(event.id), event.patch);
    if (event.type === 'busy' && !event.busy && items.size) turnEnded = true;
  });
  await new Promise((resolve, reject) => (panel.on('open', resolve), panel.on('error', reject)));

  // Started the way the panel's Comment button does it: panel -> server -> add-on -> page.
  await bridge.call('javascript', { tabId, code: 'window.focus(); 1' });
  panel.send(JSON.stringify({ type: 'comment_mode' }));
  await until((x) => x.picking, 8);
  check('comment mode waits for a click', (await state()).picking);
  const box = JSON.parse(await bridge.call('javascript', { tabId, code: '(() => { const r = document.getElementById("press").getBoundingClientRect(); return [r.left + 10, r.top + 8]; })()' }));
  await bridge.call('click', { tabId, coordinate: box });
  s = await state();
  check('clicking opens a comment box on that element', !s.picking && s.cards[0] && /On: button "Press me"/.test(s.cards[0].text), s);
  const pressed = await bridge.call('javascript', { tabId, code: 'document.getElementById("press").textContent' });
  check('the click was not passed to the page', /Press me/.test(pressed), pressed);
  await page('overlay_type', { text: 'What does this button say? Answer with just its label.' });
  await shot('comment');
  await page('overlay_click', { text: 'Send' });
  for (const end = Date.now() + 150000; Date.now() < end && !turnEnded; await sleep(500));
  const all = [...items.values()];
  const user = all.find((i) => i.type === 'user');
  const said = all.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  check('the comment reaches the chat panel', !!user && /What does this button say/.test(user.text) && /Pinned on button/.test(user.text), all);
  check('Claude answers about the pinned element', turnEnded && /press me/i.test(said), all);
  console.log('      Claude said: ' + said.slice(0, 200));
  s = await state();
  check('the pin stays on the page with the comment', s.marks.length === 1 && /What does this button say/.test(s.marks[0].text), s);

  // --- which tab the user is on ---------------------------------------------
  // Each message carries a note of the tab in front when it was sent, so "this
  // page" is right even with several windows and conversations.
  turnEnded = false;
  const itemsBefore = items.size;
  await bridge.call('javascript', { tabId, code: 'window.focus(); 1' });
  const frontTabId = (await bridge.call('tabs_list', {})).find((t) => t.current)?.tabId;
  panel.send(JSON.stringify({ type: 'send', text: 'Without calling any tools: what is the id of the tab I am looking at? Reply with just the number.' }));
  for (const end = Date.now() + 120000; Date.now() < end && !turnEnded; await sleep(500));
  const fresh = [...items.values()].slice(itemsBefore);
  const tabAnswer = fresh.filter((i) => i.type === 'text').map((i) => i.text).join(' ');
  check('Claude is told which tab the user is on', turnEnded && tabAnswer.includes(String(frontTabId)) && !fresh.some((i) => i.type === 'tool'), { frontTabId, fresh });
  check('the note is not shown in the panel', fresh.find((i) => i.type === 'user')?.text.startsWith('Without calling'), fresh);

  // --- conversation history ---------------------------------------------------
  const next = (type) =>
    new Promise((resolve) => {
      const on = (data) => {
        const event = JSON.parse(data.toString());
        if (event.type !== type) return;
        panel.off('message', on);
        resolve(event);
      };
      panel.on('message', on);
    });
  const ask = (msg, reply) => {
    const got = next(reply);
    panel.send(JSON.stringify(msg));
    return got;
  };
  await ask({ type: 'reset' }, 'reset');
  let listed = await ask({ type: 'list' }, 'conversations');
  check('New chat files the conversation in the history', listed.list.length === 1 && /What does this button say/.test(listed.list[0].title) && listed.current !== listed.list[0].id, listed);
  const reopened = await ask({ type: 'open', id: listed.list[0].id }, 'history');
  check('a past conversation can be reopened', reopened.id === listed.list[0].id && reopened.events.some((i) => i.type === 'text' && /press me/i.test(i.text)), reopened);
  listed = await ask({ type: 'delete', id: listed.list[0].id }, 'conversations');
  check('a conversation can be deleted', listed.list.length === 0, listed);

  // --- a drawing in the chat --------------------------------------------------
  turnEnded = false;
  panel.send(JSON.stringify({ type: 'send', text: 'Draw a small bar chart in the chat comparing the values 3 and 5. Keep it very simple.' }));
  for (const end = Date.now() + 150000; Date.now() < end && !turnEnded; await sleep(500));
  panel.close();
  await sleep(500);
  // Claude's tools must refuse the panel page itself: it is where access is granted
  // and prompts are answered. (That the drawing renders there is checked by eye from
  // scripts/overlay-figure.jpg when the look changes, and its serving by the parallel test.)
  const ownPanel = await attempt('tab_create', { url: CHAT + '/' });
  check('the browser tools refuse to open the chat panel', !ownPanel.ok && /own pages/.test(ownPanel.value), ownPanel);

  // --- the add-on's own pages -----------------------------------------------------
  const ownSidebar = await attempt('tab_create', { url: (await bridge.call('hello')).base + 'sidebar.html' });
  check("the browser tools refuse the add-on's own pages", !ownSidebar.ok && /own pages/.test(ownSidebar.value), ownSidebar);

  // --- strict CSP page ------------------------------------------------------
  await bridge.call('navigate', { tabId, url: base + '/strict' });
  const strictFound = await bridge.call('find', { tabId, query: '#press' });
  await bridge.call('annotate', { tabId, marks: [{ ref: strictFound.match(/ref=(e\d+)/)[1], label: 'Works under strict CSP' }], dim: true });
  await bridge.call('show_card', { tabId, html: cardHtml, title: 'Strict page card', width: 300, height: 160 });
  await sleep(1500);
  s = await state();
  check('marks and cards work on a strict-CSP page', s.marks.length === 1 && s.cards.length === 1, s);
  await shot('strict');

  await bridge.call('tab_close', { tabId });
} catch (err) {
  check('test run', false, err.stack);
} finally {
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  bridge.close();
  chat.kill();
  site.close();
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '-start-debugger-server [0-9]+ .*-profile .*firefox-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    spawnSync('taskkill', ['/pid', String(webExt.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    webExt.kill();
  }
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  }, 800);
}
