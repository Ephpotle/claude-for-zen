// End-to-end smoke test: launches a throwaway Zen instance with the extension,
// starts the MCP server the way Claude Code would, and drives a local test page.
//
//   npm test                 (uses C:/Program Files/Zen Browser/zen.exe)
//   ZEN_PATH=/path/to/zen npm test

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zenPath = process.env.ZEN_PATH || 'C:/Program Files/Zen Browser/zen.exe';

const PAGE = `<!doctype html><html><head><title>Smoke page</title>
<meta http-equiv="Content-Security-Policy" content="CSP_PLACEHOLDER"></head><body>
<h1>Claude for Zen smoke page</h1>
<nav aria-label="Primary"><a href="/second">Second page</a></nav>
<form id="f"><label for="name">Your name</label><input id="name" name="name" placeholder="Name">
<label><input type="checkbox" id="agree"> I agree</label>
<select id="color" aria-label="Colour"><option value="r">Red</option><option value="g">Green</option></select>
<button type="submit">Send</button></form>
<button id="count">Count: 0</button>
<div id="card" style="cursor:pointer">Clickable card</div>
<button id="boom">Throw</button>
<div id="out"></div><div id="echo"></div>
<div style="height:3000px"></div><p id="bottom">The very bottom</p>
<script>
  window.pageVar = 42;
  console.log('page loaded', {answer: 42});
  const out = document.getElementById('out');
  let n = 0;
  document.getElementById('count').onclick = (e) => { e.target.textContent = 'Count: ' + (++n); console.warn('counted', n); };
  document.getElementById('card').addEventListener('click', () => { out.textContent = 'card clicked'; });
  document.getElementById('boom').onclick = () => { throw new Error('kaboom'); };
  document.getElementById('name').addEventListener('input', (e) => { document.getElementById('echo').textContent = 'echo:' + e.target.value; });
  document.getElementById('f').addEventListener('submit', (e) => {
    e.preventDefault();
    out.textContent = 'submitted:' + document.getElementById('name').value + ':' + document.getElementById('agree').checked + ':' + document.getElementById('color').value;
  });
  fetch('/api/ping');
</script></body></html>`;

const site = http.createServer((req, res) => {
  if (req.url === '/api/ping') return res.end('pong');
  res.setHeader('content-type', 'text/html');
  if (req.url === '/second') return res.end('<title>Second</title><h1>Second page</h1><a href="/">Home</a>');
  // /strict has a CSP that forbids eval, to exercise the javascript fallback.
  res.end(PAGE.replace('CSP_PLACEHOLDER', req.url === '/strict' ? "script-src 'unsafe-inline'" : "default-src * 'unsafe-inline' 'unsafe-eval'"));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const client = new Client({ name: 'smoke-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server/index.js')], stderr: 'inherit', env: { ...process.env, CLAUDE_FOR_ZEN_DEV_ONLY: '1' } })); // never drive your everyday browser

const webExt = spawn(
  process.execPath,
  [path.join(root, 'node_modules/web-ext/bin/web-ext.js'), 'run', '--source-dir', path.join(root, 'extension'), '--firefox', zenPath, '--no-input', '--no-reload', '--pref', 'zen.welcome-screen.seen=true', '--pref', 'browser.shell.checkDefaultBrowser=false'],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

// web-ext's browser outlives web-ext itself on Windows, so stop it by its
// temporary profile: only instances web-ext launched have one.
function stopBrowser() {
  if (process.platform !== 'win32') return void webExt.kill();
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '-start-debugger-server [0-9]+ .*-profile .*firefox-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  spawnSync('taskkill', ['/pid', String(webExt.pid), '/T', '/F'], { stdio: 'ignore' });
}

let failures = 0;
const results = [];
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: !!res.isError, content: res.content };
}
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${String(detail).slice(0, 600)}`}`);
  if (!ok) failures++;
}
const refFor = (outline, needle) => {
  const line = outline.split('\n').find((l) => l.includes(needle));
  return line?.match(/\[ref=(e\d+)\]/)?.[1];
};

try {
  // The browser needs a while to start; tabs_list waits 8s per attempt.
  let tabs;
  for (let i = 0; i < 12; i++) {
    tabs = await call('tabs_list');
    if (!tabs.isError) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // A fresh Zen profile with the welcome screen skipped has no real tabs yet.
  check('extension connects, tabs_list', !tabs.isError && /tab/i.test(tabs.text), tabs.text);

  const created = await call('tab_create', { url: base + '/' });
  const tabId = JSON.parse(created.text).tabId;
  check('tab_create loads page', created.text.includes('Smoke page') && created.text.includes('"load": "complete"'), created.text);

  let page = await call('read_page', { tabId });
  check('read_page interactive', ['link "Second page"', 'textbox "Your name"', 'checkbox', 'combobox "Colour"', 'button "Send"', 'Clickable card'].every((s) => page.text.includes(s)), page.text);
  const all = await call('read_page', { tabId, filter: 'all' });
  check('read_page all', all.text.includes('heading "Claude for Zen smoke page"') && all.text.includes('navigation "Primary"'), all.text);

  const text = await call('get_page_text', { tabId });
  check('get_page_text', text.text.includes('The very bottom'), text.text);

  const found = await call('find', { tabId, query: 'count' });
  const countRef = refFor(found.text, 'Count: 0');
  check('find by text', !!countRef, found.text);
  const bySelector = await call('find', { tabId, query: '#bottom' });
  check('find by selector', bySelector.text.includes('ref='), bySelector.text);

  await call('click', { tabId, ref: countRef });
  await call('click', { tabId, ref: countRef });
  let js = await call('javascript', { tabId, code: 'document.getElementById("count").textContent' });
  check('click by ref', js.text.includes('Count: 2'), js.text);

  js = await call('javascript', { tabId, code: 'window.pageVar + 1' });
  check('javascript sees page variables', js.text.trim() === '43', js.text);
  js = await call('javascript', { tabId, code: 'new Promise(r => setTimeout(() => r({a: [1, 2]}), 50))' });
  check('javascript awaits promises', js.text.includes('"a"'), js.text);
  js = await call('javascript', { tabId, code: 'nope.nope' });
  check('javascript reports errors', js.isError && js.text.includes('nope'), js.text);

  const rect = JSON.parse((await call('javascript', { tabId, code: '(() => { const r = document.getElementById("card").getBoundingClientRect(); return [r.left + 20, r.top + 5]; })()' })).text);
  const coordClick = await call('click', { tabId, coordinate: rect });
  console.log('      coordinate click:', JSON.stringify(rect), coordClick.text);
  js = await call('javascript', { tabId, code: 'document.getElementById("out").textContent' });
  check('click by coordinate', js.text.includes('card clicked'), js.text);

  const nameRef = refFor(page.text, 'Your name');
  const typed = await call('type', { tabId, ref: nameRef, text: 'Markus' });
  await call('key', { tabId, key: 'Backspace' });
  await call('key', { tabId, key: 's' });
  js = await call('javascript', { tabId, code: 'document.getElementById("echo").textContent' });
  check('type + key fire input events', js.text.includes('echo:Markus'), typed.text + ' / ' + js.text);

  await call('form_input', { tabId, ref: refFor(page.text, 'checkbox'), value: true });
  const sel = await call('form_input', { tabId, ref: refFor(page.text, 'Colour'), value: 'Green' });
  await call('key', { tabId, key: 'Enter', ref: nameRef });
  js = await call('javascript', { tabId, code: 'document.getElementById("out").textContent' });
  check('form_input + Enter submits form', js.text.includes('submitted:Markus:true:g'), sel.text + ' / ' + js.text);

  const replaced = await call('form_input', { tabId, ref: nameRef, value: 'Replaced' });
  js = await call('javascript', { tabId, code: 'document.getElementById("name").value' });
  check('form_input replaces text', js.text.includes('Replaced'), replaced.text + js.text);

  const scrolled = await call('scroll', { tabId, direction: 'down', amount: 800 });
  js = await call('javascript', { tabId, code: 'window.scrollY' });
  check('scroll', Number(js.text) >= 700, scrolled.text + js.text);
  await call('scroll', { tabId, ref: refFor(bySelector.text, 'ref=') });
  js = await call('javascript', { tabId, code: 'document.getElementById("bottom").getBoundingClientRect().top < innerHeight' });
  check('scroll ref into view', js.text.trim() === 'true', js.text);

  const shot = await call('screenshot', { tabId });
  const image = shot.content.find((c) => c.type === 'image');
  check('screenshot', !!image && image.data.length > 2000 && /Viewport \d+x\d+/.test(shot.text), shot.text);
  console.log('      screenshot:', shot.text);
  if (image) writeFileSync(path.join(root, 'scripts', 'last-screenshot.jpg'), Buffer.from(image.data, 'base64'));

  await call('click', { tabId, ref: refFor(page.text, 'Throw') });
  let logs = await call('console_messages', { tabId });
  console.log('      console:', logs.text);
  check('console captures warn + uncaught error', logs.text.includes('counted 2') && logs.text.includes('kaboom'), logs.text);

  const reloaded = await call('navigate', { tabId, url: 'reload' });
  logs = await call('console_messages', { tabId, pattern: 'page loaded' });
  check('console captures from page start after reload', reloaded.text.includes('complete') && logs.text.includes('page loaded'), logs.text);
  const net = await call('network_requests', { tabId, pattern: 'ping' });
  check('network_requests', net.text.includes('200 GET') && net.text.includes('/api/ping'), net.text);

  page = await call('read_page', { tabId });
  await call('click', { tabId, ref: refFor(page.text, 'Second page') });
  const waited = await call('wait_for', { tabId, selector: 'a[href="/"]', seconds: 10 });
  const after = await call('tabs_list');
  check('clicking a link navigates', !waited.isError && after.text.includes(base + '/second'), waited.text);
  check('tabs_list marks the current tab', /Current tab[^\n]*\n\[\d+\] Second/.test(after.text), after.text);
  const searched = await call('tabs_list', { query: 'no-such-tab-anywhere' });
  check('tabs_list query filters', searched.text.includes('No other tabs match'), searched.text);
  const back = await call('navigate', { tabId, url: 'back' });
  check('navigate back', back.text.includes('Smoke page'), back.text);

  await call('navigate', { tabId, url: base + '/strict' });
  const stale = await call('click', { tabId, ref: countRef });
  check('stale ref gives a clear error', stale.isError && stale.text.includes('no longer'), stale.text);
  // On a page whose policy forbids eval, the code runs as a script of the page itself
  // (never in the add-on's own world, where it would have the add-on's powers).
  js = await call('javascript', { tabId, code: 'document.title' });
  check('javascript works under strict CSP', !js.isError && js.text.includes('Smoke page'), js.text);
  js = await call('javascript', { tabId, code: '[typeof browser, typeof chrome, typeof window.wrappedJSObject].join()' });
  check('and there it has no add-on powers', !js.isError && js.text.includes('undefined,undefined,undefined'), js.text);
  js = await call('javascript', { tabId, code: 'const t = document.title; return t.length > 3 ? "long" : "short";' });
  check('several statements work there with return', !js.isError && js.text.includes('long') && js.text.includes('use `return`'), js.text);
  js = await call('javascript', { tabId, code: 'new Promise((r) => setTimeout(() => r({ a: [1, 2] }), 50))' });
  check('promises are awaited there', !js.isError && js.text.includes('"a"'), js.text);
  js = await call('javascript', { tabId, code: 'nope.nope' });
  check('and errors are reported there', js.isError && js.text.includes('nope'), js.text);
  const stillReads = await call('get_page_text', { tabId });
  check('the page can still be read under strict CSP', !stillReads.isError && stillReads.text.includes('The very bottom'), stillReads.text);

  // Claude must not be able to open or operate Claude for Zen's own pages (the chat panel
  // is where access is granted and permission prompts are answered).
  const ownNew = await call('tab_create', { url: 'http://127.0.0.1:47810/' });
  const ownNav = await call('navigate', { tabId, url: 'http://claude.localhost/?q=hello' });
  const ownVm = await call('navigate', { tabId, url: 'http://localhost:47811/mcp' });
  check('own pages cannot be opened or navigated to', [ownNew, ownNav, ownVm].every((r) => r.isError && /own pages/.test(r.text)), [ownNew.text, ownNav.text, ownVm.text].join(' | '));
  const otherLocal = await call('navigate', { tabId, url: base + '/' });
  check('other local pages still work', !otherLocal.isError && otherLocal.text.includes('Smoke page'), otherLocal.text);

  const restricted = await call('navigate', { tabId, url: 'about:config' });
  check('privileged URL is refused', restricted.isError, restricted.text);

  // Zen unloads idle tabs; using one must load it again instead of failing.
  await call('navigate', { tabId, url: base + '/' });
  const windowId = JSON.parse(created.text).windowId;
  const front = await call('tab_create', { url: base + '/second', windowId });
  check('tab_create opens in the given window', JSON.parse(front.text).windowId === windowId, front.text);
  const elsewhere = await call('tab_create', { url: base + '/second', windowId: 987654 });
  check('tab_create falls back when that window is gone', !elsewhere.isError && elsewhere.text.includes('"load": "complete"'), elsewhere.text);
  await call('tab_close', { tabId: JSON.parse(elsewhere.text).tabId });
  const unloaded = await call('tab_discard', { tabId });
  const listed = await call('tabs_list', { query: 'Smoke' });
  check('tabs_list marks an unloaded tab', !unloaded.isError && listed.text.includes('(unloaded'), unloaded.text + ' / ' + listed.text);
  const woken = await call('get_page_text', { tabId });
  check('using an unloaded tab loads it again', !woken.isError && woken.text.includes('The very bottom'), woken.text);
  await call('tab_close', { tabId: JSON.parse(front.text).tabId });

  const closed = await call('tab_close', { tabId });
  check('tab_close', !closed.isError, closed.text);
} catch (err) {
  check('test run', false, err.stack);
} finally {
  console.log('\n' + results.join('\n'));
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  await client.close().catch(() => {});
  stopBrowser();
  site.close();
  setTimeout(() => process.exit(failures ? 1 : 0), 1500);
}
