// Test for parallel sessions: two panels (as in two browser windows) each get
// their own conversation and their own Claude, working at the same time.
//
// Runs a chat server on a test port with its own settings folder. No browser is
// needed; the questions asked do not use one.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47816;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A one-colour PNG as base64, made by hand so the test needs no image library. */
function solidPng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const home = mkdtempSync(path.join(os.tmpdir(), 'claude-for-zen-test-'));
const chat = spawn(process.execPath, [path.join(root, 'chat/server.js')], {
  env: { ...process.env, CLAUDE_FOR_ZEN_CHAT_PORT: String(PORT), CLAUDE_FOR_ZEN_HOME: home, CLAUDE_FOR_ZEN_DEV_ONLY: '1', CLAUDE_FOR_ZEN_MODEL: 'haiku', CLAUDE_FOR_ZEN_VM_PORT: '47826' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1200)}`);
  if (!ok) failures++;
};

/** One panel, as the page in a window's sidebar would be. */
async function panel(token, seat = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}&seat=${seat}`, { origin: base });
  const p = { ws, items: new Map(), busy: false, id: null, settings: null, list: null, notice: null, sawBusy: false, idle: null, status: null, phases: new Set() };
  ws.on('message', (data) => {
    const e = JSON.parse(data.toString());
    if (e.id && e.type !== 'delta' && e.type !== 'update') p.id = e.id;
    if (e.type === 'history') {
      p.items = new Map(e.events.map((i) => [i.id, i]));
      p.busy = e.busy;
      p.settings = e.settings;
    }
    if (e.type === 'reset') p.items = new Map();
    if (e.type === 'item') p.items.set(e.item.id, e.item);
    if (e.type === 'delta') p.items.get(e.id).text += e.text;
    if (e.type === 'update') Object.assign(p.items.get(e.id) ?? {}, e.patch);
    if (e.type === 'settings') p.settings = e.settings;
    if (Array.isArray(e.commands)) p.commands = e.commands;
    if (e.type === 'commands') p.commands = e.list;
    if (e.status) {
      p.status = e.status;
      p.phases.add(e.status.phase);
    }
    if (e.type === 'conversations') p.list = e.list;
    if (e.type === 'notice') p.notice = e.text;
    if (e.type === 'busy') {
      if (e.busy) p.sawBusy = true;
      if (p.busy && !e.busy) p.idle?.();
      p.busy = e.busy;
    }
  });
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)));
  await sleep(200);
  p.say = (text) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('turn timed out')), 180_000);
      p.idle = () => (clearTimeout(timer), resolve());
      ws.send(JSON.stringify({ type: 'send', text }));
    });
  p.tell = (msg) => (ws.send(JSON.stringify(msg)), sleep(300));
  p.text = () => [...p.items.values()].filter((i) => i.type === 'text').map((i) => i.text).join('\n');
  return p;
}

try {
  await sleep(1500);
  const token = (await (await fetch(base + '/')).text()).match(/name="token" content="([0-9a-f]+)"/)[1];

  const a = await panel(token);
  const b = await panel(token);
  check('a second panel gets its own conversation', a.id && b.id && a.id !== b.id, [a.id, b.id]);

  // Both at once. Each is asked to count slowly so the turns overlap.
  let bothBusy = false;
  const watch = setInterval(() => (bothBusy ||= a.busy && b.busy), 50);
  await Promise.all([
    a.say('Write the numbers one to thirty as words, one per line, then on the last line the single word APPLE.'),
    b.say('Write the numbers one to thirty as words, one per line, then on the last line the single word PEAR.'),
  ]);
  clearInterval(watch);
  check('both were working at the same time', bothBusy);
  check('each panel got its own answer', /APPLE/.test(a.text()) && !/PEAR/.test(a.text()) && /PEAR/.test(b.text()) && !/APPLE/.test(b.text()), [a.text().slice(-80), b.text().slice(-80)]);

  // The status line: what Claude is doing while it works, and a summary when it is done.
  check('the status follows the turn and ends with a summary', a.phases.has('starting') && a.phases.has('writing') && a.status?.phase === 'done' && a.status.tokens > 20 && a.status.ended > a.status.since, [[...a.phases], a.status]);

  // A reload of window A's panel comes back to A's conversation, not B's.
  a.ws.close();
  await sleep(300);
  const a2 = await panel(token, a.id);
  check('a reloaded panel returns to its own conversation', a2.id === a.id && /APPLE/.test(a2.text()), [a2.id, a.id]);

  // A panel reopened without remembering anything takes the seat nobody is looking at.
  a2.ws.close();
  await sleep(300);
  const a3 = await panel(token);
  check('a reopened sidebar picks up the conversation that has no panel', a3.id === a.id, [a3.id, a.id, b.id]);

  const c = await panel(token);
  check('a third window gets a fresh conversation', c.id !== a.id && c.id !== b.id && c.items.size === 0, c.id);
  const cFirst = c.id;

  // A new conversation can look up what an earlier one did.
  await c.say('In an earlier conversation I asked you for a list that ended with the word PEAR. Find that conversation and tell me: how many numbers did I ask you to write? Answer with the number as a word.');
  const looked = [...c.items.values()].filter((i) => i.type === 'tool' && i.name.startsWith('mcp__history__') && i.state === 'done');
  check('a new conversation can look up an earlier one', looked.length > 0 && /thirty/i.test(c.text()) && ![...c.items.values()].some((i) => i.type === 'ask'), [...c.items.values()]);
  // A picture pasted into the panel goes to Claude with the message; only a small preview is kept.
  const red = solidPng(48, 48, [220, 30, 30]);
  c.ws.send(JSON.stringify({ type: 'send', text: 'What single colour fills this picture? Answer with one word.', images: [{ mediaType: 'image/png', data: red, preview: 'data:image/png;base64,' + red }, { mediaType: 'text/html', data: 'PGI+' }] }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('picture turn timed out')), 180_000);
    c.idle = () => (clearTimeout(timer), resolve());
  });
  const sentPicture = [...c.items.values()].find((i) => i.type === 'user' && i.pictures);
  check('a pasted picture reaches Claude', /red/i.test(c.text()) && sentPicture?.pictures === 1 && sentPicture.previews?.length === 1, [sentPicture && { ...sentPicture, previews: sentPicture.previews?.length }, c.text().slice(-80)]);
  await c.tell({ type: 'reset' });

  // Graphics in the reply itself, and a report for the developer.
  await c.say('Draw a small bar chart in the chat comparing the values 3 and 5.');
  const figure = [...c.items.values()].find((i) => i.type === 'figure');
  const served = figure ? await fetch(`${base}/figure/${c.id}/${figure.id}`) : null;
  check('Claude can draw a figure in the chat', !!figure && served?.status === 200 && /sandbox/.test(served.headers.get('content-security-policy') ?? '') && /<svg|<canvas|<div/i.test(await served.text()), [...c.items.values()].slice(-4));
  await c.say('File a report for the developer titled "Parallel test report" saying only: hello from the test.');
  const reports = existsSync(path.join(home, 'dev-reports')) ? readdirSync(path.join(home, 'dev-reports')) : [];
  check('Claude can file a report for the developer', reports.length === 1 && /hello from the test/.test(readFileSync(path.join(home, 'dev-reports', reports[0]), 'utf8')), reports);
  await c.tell({ type: 'reset' });

  await a3.tell({ type: 'settings', effort: 'low' });
  check('a settings change reaches the other windows', b.settings?.effort === 'low' && c.settings?.effort === 'low', [b.settings, c.settings]);

  await b.tell({ type: 'list' });
  const other = b.list?.find((entry) => entry.id === a.id);
  check('history marks a conversation that is open in another window', other?.elsewhere === true && b.list.find((e) => e.id === b.id)?.elsewhere === false, b.list);

  await b.tell({ type: 'delete', id: a.id });
  check('a conversation open elsewhere cannot be deleted from here', /another window/.test(b.notice ?? '') && b.list.some((e) => e.id === a.id), [b.notice]);

  await c.tell({ type: 'open', id: a.id });
  check('opening it from history joins that conversation', c.id === a.id && /APPLE/.test(c.text()), [c.id, c.text().slice(-60)]);

  await c.tell({ type: 'reset' });
  check('New chat in one window leaves the other window alone', b.items.size > 0 && /PEAR/.test(b.text()), b.text().slice(-60));

  // Opening a plain browser window asks in every mode, "Browser only" included; here it is refused.
  await b.tell({ type: 'settings', access: 'browser', folder: '' });
  const asksBefore = [...b.items.values()].filter((i) => i.type === 'ask').length;
  b.ws.send(JSON.stringify({ type: 'send', text: 'Open a separate plain browser window at https://example.com/ for me.' }));
  let plainAsk = null;
  for (const end = Date.now() + 120000; Date.now() < end && !plainAsk; await sleep(300)) plainAsk = [...b.items.values()].filter((i) => i.type === 'ask')[asksBefore];
  check('opening a plain browser window asks first, even in Browser only', !!plainAsk && /plain Zen window at example.com/.test(plainAsk.title) && /Claude cannot see or operate it/.test(plainAsk.body), plainAsk);
  if (plainAsk) b.ws.send(JSON.stringify({ type: 'answer', id: plainAsk.id, allow: false }));
  for (const end = Date.now() + 60000; Date.now() < end && b.busy; await sleep(300));
  check('refusing opens nothing', ![...b.items.values()].some((i) => i.type === 'tool' && i.name === 'mcp__history__open_plain_browser' && i.state === 'done'), [...b.items.values()].slice(-3));

  // A permission question in one window is announced in the others.
  // When the browser starts (the add-on connects) and userscripts are on, the add-on is asked
  // to open Violentmonkey's connect page, so the user only has to press Approve.
  await b.tell({ type: 'settings', scripts: true });
  const addon = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, { origin: 'moz-extension://11111111-2222-3333-4444-555555555555' });
  const asked = new Promise((resolve) => {
    addon.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'approve_userscripts') resolve(msg.url);
    });
    setTimeout(() => resolve(null), 20000);
  });
  await new Promise((resolve, reject) => (addon.on('open', resolve), addon.on('error', reject)));
  addon.send(JSON.stringify({ type: 'control', version: 'test' }));
  const connectUrl = await asked;
  check('at browser start the add-on is asked to open the Violentmonkey connect page', String(connectUrl).startsWith('https://violentmonkey.github.io/mcp_connect.html?port=47826&token='), connectUrl);
  addon.close();
  await b.tell({ type: 'settings', scripts: false });

  // Slash commands: the list comes from Claude Code, and a command's answer shows in the chat.
  check('the panel is told which slash commands exist', Array.isArray(b.commands) && b.commands.includes('context') && !b.commands.includes('clear') && !b.commands.includes('model'), b.commands);
  await c.tell({ type: 'reset' });
  await c.say('/context');
  check('a slash command runs and its answer is shown', /Context Usage/i.test(c.text()) && ![...c.items.values()].some((i) => i.type === 'error'), [...c.items.values()].slice(-3));

  // A helper (subagent): its progress shows under the step that started it.
  await c.tell({ type: 'reset' });
  await c.say('Start one helper (a general-purpose subagent) and have it work out 17 times 23. Then tell me its answer.');
  // The helper may be left working in the background; Claude then picks up by itself when it reports.
  for (const end = Date.now() + 120000; Date.now() < end && !(/391/.test(c.text()) && !c.busy); await sleep(400));
  const helperStep = [...c.items.values()].find((i) => i.type === 'tool' && i.helper);
  check('a helper shows under the step that started it', !!helperStep && /^Helper: /.test(helperStep.label) && helperStep.helper.state === 'done' && helperStep.state === 'done' && /391/.test(c.text()), [helperStep, c.text().slice(-80)]);
  await c.tell({ type: 'reset' });

  // Rename and archive, from History.
  await b.tell({ type: 'rename', id: a.id, title: '  Apples   to thirty ' });
  check('a conversation can be renamed', b.list?.find((e) => e.id === a.id)?.title === 'Apples to thirty', b.list);
  await b.tell({ type: 'archive', id: a.id, archived: true });
  check('and archived, which keeps it', b.list?.find((e) => e.id === a.id)?.archived === true, b.list);
  await b.tell({ type: 'archive', id: a.id, archived: false });
  await b.tell({ type: 'rename', id: a.id, title: '' });
  check('an empty name goes back to the first message', /^Write the numbers/.test(b.list?.find((e) => e.id === a.id)?.title ?? ''), b.list);

  // Switching away from a conversation that is working leaves it working.
  const busyId = b.id;
  b.ws.send(JSON.stringify({ type: 'send', text: 'Write the numbers one to sixty as words, one per line, then the single word PLUM.' }));
  for (const end = Date.now() + 30000; Date.now() < end && !b.busy; await sleep(100));
  await b.tell({ type: 'reset' });
  const movedTo = b.id;
  await b.tell({ type: 'list' });
  const left = b.list?.find((e) => e.id === busyId);
  check('New chat while Claude works does not stop it', movedTo !== busyId && b.items.size === 0 && left?.working === true, [movedTo, busyId, left]);
  for (const end = Date.now() + 120000; Date.now() < end; await sleep(500)) {
    await b.tell({ type: 'list' });
    if (b.list?.find((e) => e.id === busyId)?.working === false) break;
  }
  await b.tell({ type: 'open', id: busyId });
  check('and it finished in the background', b.id === busyId && /PLUM/.test(b.text()), [b.id, b.text().slice(-60)]);

  // The look is shared by every window, and changing it does not disturb Claude.
  await b.tell({ type: 'settings', theme: 'ledger' });
  const page = await (await fetch(base + '/')).text();
  check('a look chosen in one window reaches the others and new pages', a3.settings?.theme === 'ledger' && c.settings?.theme === 'ledger' && /data-theme="ledger"/.test(page), [a3.settings, c.settings]);
  await b.tell({ type: 'settings', theme: 'nonsense' });
  check('an unknown look is ignored', b.settings?.theme === 'ledger', b.settings);

  // An access level belongs to one conversation, unless it is set for all of them.
  await b.tell({ type: 'settings', access: 'ask', folder: home });
  check('an access level is for one conversation only', b.settings?.access === 'ask' && a3.settings?.access === 'browser' && c.settings?.access === 'browser', [b.settings, a3.settings, c.settings]);
  await b.tell({ type: 'reset' });
  check('a new chat starts with the browser only', b.settings?.access === 'browser', b.settings);
  await b.tell({ type: 'settings', access: 'ask', accessForAll: true });
  check('"use this in every conversation" applies it to the others', a3.settings?.access === 'ask' && c.settings?.access === 'ask' && a3.settings?.accessForAll === true, [a3.settings, c.settings]);
  await b.tell({ type: 'reset' });
  check('and then a new chat keeps it', b.settings?.access === 'ask', b.settings);
  b.notice = null;
  a3.ws.send(JSON.stringify({ type: 'send', text: 'Create a file called hello.txt containing the word hi in the working folder. Use the Write tool.' }));
  let question = null;
  for (const end = Date.now() + 120000; Date.now() < end && !question; await sleep(300)) question = [...a3.items.values()].find((i) => i.type === 'ask' && i.state === 'waiting');
  await sleep(300);
  check('a question waiting in one window is announced in the other', !!question && /waiting for your OK/.test(b.notice ?? ''), [question, b.notice]);
  if (question) a3.ws.send(JSON.stringify({ type: 'answer', id: question.id, allow: false }));
  await sleep(500);
  a3.ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(500);

  for (const p of [a3, b, c]) p.ws.close();
} catch (err) {
  check('test run', false, err.stack);
} finally {
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  chat.kill();
  setTimeout(() => {
    rmSync(home, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  }, 1500);
}
