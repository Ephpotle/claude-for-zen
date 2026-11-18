// Claude for Zen — background page.
//
// Connects out to every Claude for Zen MCP server on localhost (one per
// Claude Code session), runs the commands they send, and replies.

const HOST = '127.0.0.1';
const BASE_PORT = 47800;
const PORT_COUNT = 10; // Claude Code sessions plus chat panel conversations, one port each (47810 up is the chat server)
const SCAN_MS = 2000;
const BUFFER_MAX = 500;

const BUSY = 4001; // server close code: that session already has a browser
const BUSY_RETRY_MS = 20000;

const sockets = new Map(); // port -> WebSocket (connecting or open)
const retryAfter = new Map(); // port -> time before which not to retry
const probing = new Set(); // ports with a probe in flight
const claimed = new Set(); // tab IDs Claude has used; console capture is on for these
const consoleLogs = new Map(); // tabId -> [{level, text, time}]
const requests = new Map(); // tabId -> [{method, url, status, type, time}]

// ---------------------------------------------------------------- connection

function scan() {
  for (let i = 0; i < PORT_COUNT; i++) {
    const port = BASE_PORT + i;
    if (!sockets.has(port) && !probing.has(port) && Date.now() >= (retryAfter.get(port) || 0)) probe(port);
  }
}

// Ask over plain HTTP whether a Claude for Zen server is on this port, and only
// then open the WebSocket. Firefox penalises ports where WebSocket connections
// keep failing with reconnect delays of up to a minute; failed fetches are free.
async function probe(port) {
  probing.add(port);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1500);
  try {
    const res = await fetch(`http://${HOST}:${port}/`, { cache: 'no-store', signal: abort.signal });
    const info = await res.json();
    if (info && info.app === 'claude-for-zen' && !sockets.has(port)) connect(port);
  } catch {
    // nothing listening, or something else owns the port
  } finally {
    clearTimeout(timer);
    probing.delete(port);
  }
}

function connect(port) {
  let ws;
  try {
    ws = new WebSocket(`ws://${HOST}:${port}`);
  } catch {
    return;
  }
  sockets.set(port, ws);
  ws.onopen = updateBadge;
  ws.onclose = (event) => {
    if (sockets.get(port) === ws) sockets.delete(port);
    if (event.code === BUSY) retryAfter.set(port, Date.now() + BUSY_RETRY_MS);
    updateBadge();
  };
  ws.onerror = () => {};
  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const reply = { id: msg.id };
    try {
      const handler = handlers[msg.method];
      if (!handler) {
        throw new Error(`The installed Claude for Zen add-on (${browser.runtime.getManifest().version}) is too old for "${msg.method}". Update the add-on.`);
      }
      reply.result = await handler(msg.params || {});
      if (reply.result === undefined) reply.result = 'ok';
    } catch (err) {
      reply.error = String((err && err.message) || err);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
}

function sessionCount() {
  let n = 0;
  for (const ws of sockets.values()) if (ws.readyState === WebSocket.OPEN) n++;
  return n;
}

let waiting = 0; // chat panel conversations that are waiting for the user's OK

function updateBadge() {
  const n = sessionCount();
  if (waiting) {
    // A permission question is easy to miss when its panel is in another window or closed.
    browser.browserAction.setBadgeText({ text: '?' });
    browser.browserAction.setBadgeBackgroundColor({ color: '#2f6b4f' });
    browser.browserAction.setTitle({ title: 'Claude for Zen — Claude is waiting for your OK in the chat panel' });
    return;
  }
  browser.browserAction.setBadgeText({ text: n ? String(n) : '' });
  browser.browserAction.setBadgeBackgroundColor({ color: '#d97757' });
  browser.browserAction.setTitle({
    title: n ? `Claude for Zen — ${n} Claude Code session${n > 1 ? 's' : ''} connected` : 'Claude for Zen — not connected',
  });
}

scan();
setInterval(scan, SCAN_MS);

// ------------------------------------------------------------------- helpers

function describeTab(tab) {
  return {
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    windowId: tab.windowId,
    status: tab.status,
    asleep: !!tab.discarded, // Zen unloads tabs that have not been used for a while
    container: tab.cookieStoreId && tab.cookieStoreId !== 'firefox-default' ? tab.cookieStoreId : undefined,
  };
}

/**
 * Zen unloads idle tabs to save memory; an unloaded tab has no page to talk
 * to. Load it again (in the background, without bringing it to the front).
 */
async function wake(tabId) {
  let tab = await browser.tabs.get(tabId);
  if (!tab.discarded) return tab;
  await browser.tabs.reload(tabId);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    tab = await browser.tabs.get(tabId);
    if (!tab.discarded && tab.status === 'complete') break;
  }
  return tab;
}

function push(map, tabId, entry) {
  let list = map.get(tabId);
  if (!list) map.set(tabId, (list = []));
  list.push(entry);
  if (list.length > BUFFER_MAX) list.splice(0, list.length - BUFFER_MAX);
}

/**
 * Run `action` (which starts a page load and resolves to the tab ID) and wait
 * for that tab to finish loading. Resolves 'complete', 'no-load' (nothing
 * started loading, e.g. an in-page #hash change) or 'timeout'.
 */
async function withLoad(action, timeout = 30000) {
  let tabId = null;
  let sawLoading = false;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const events = [];
  const check = () => {
    if (tabId === null) return;
    for (const [id, status] of events.splice(0)) {
      if (id !== tabId) continue;
      if (status === 'loading') sawLoading = true;
      else if (status === 'complete' && sawLoading) finish('complete');
    }
  };
  const listener = (id, change) => {
    if (!change.status) return;
    events.push([id, change.status]);
    check();
  };
  browser.tabs.onUpdated.addListener(listener);
  const timers = [setTimeout(() => finish('timeout'), timeout)];
  try {
    tabId = await action();
    check();
    timers.push(setTimeout(() => !sawLoading && finish('no-load'), 1500));
    const outcome = await done;
    return { tabId, outcome };
  } finally {
    browser.tabs.onUpdated.removeListener(listener);
    timers.forEach(clearTimeout);
  }
}

function normalizeUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return 'https://' + url;
}

// Claude must never operate Claude for Zen's own pages. The chat panel is where
// the user grants access and answers permission prompts: a Claude that could
// click there (after being misled by a web page) could switch itself to
// "without asking" or press Allow on its own requests. The same goes for the
// other local servers. This is enforced here, not left to instructions.
function isOwnPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'moz-extension:') return u.href.startsWith(browser.runtime.getURL(''));
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'claude.localhost' || host.endsWith('.claude.localhost')) return true;
  const local = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.localhost');
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return local && port >= 47800 && port <= 47829;
}
const OWN_PAGE = "That is one of Claude for Zen's own pages (the chat panel or a local server). Claude cannot open or operate those; only the user can.";
/** Throws if the tab is showing one of our own pages. */
async function guard(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (isOwnPage(tab.url) || (tab.pendingUrl && isOwnPage(tab.pendingUrl))) throw new Error(OWN_PAGE);
  return tab;
}
function guardUrl(url) {
  if (isOwnPage(url)) throw new Error(OWN_PAGE);
  return url;
}

/**
 * Run code as a script of the page itself, for pages that forbid eval.
 *
 * The scripting API injects a function, not a string, so the code is first
 * made into one here. Making a function does not run it: nothing of the code
 * executes in this background page. Because there is no eval in the page, the
 * "value of the last expression" rule cannot be kept for code with several
 * statements; such code has to `return` its result.
 */
const STRINGIFY = 'try { return v === undefined ? "undefined" : JSON.stringify(v, null, 2); } catch (e) { return String(v); }';
async function runInPageWorld(tabId, code) {
  if (!browser.scripting || !browser.scripting.executeScript) {
    throw new Error("This page's security policy forbids running script, and this browser is too old to run it another way. Use read_page, find, click, type and form_input instead.");
  }
  let func;
  let statements = false;
  try {
    func = new Function(`return (async () => { const v = await (\n${code}\n); ${STRINGIFY} })()`);
  } catch {
    try {
      func = new Function(`return (async () => { const v = await (async () => {\n${code}\n})(); ${STRINGIFY} })()`);
      statements = true;
    } catch (err) {
      throw new Error(`SyntaxError: ${err.message}`);
    }
  }
  const [outcome] = await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func });
  if (!outcome) throw new Error('The page did not run the script.');
  if (outcome.error) throw new Error(String(outcome.error.message || outcome.error));
  const note = statements
    ? "(Note: this page forbids eval, so the code ran as a function body. Its value is whatever it returned; use `return` to give a result.)"
    : '';
  return note ? `${outcome.result}\n\n${note}` : outcome.result;
}

function unscriptable(tab) {
  return new Error(
    `Zen does not let extensions touch this page (${tab.url || 'restricted page'}). Navigate the tab to a normal web page first.`,
  );
}

/** Send a command to the tab's content script, injecting it if needed. */
async function inPage(tabId, action, params = {}, { claim = true } = {}) {
  await guard(tabId);
  const tab = await wake(tabId);
  const message = { action, params };
  let response;
  // If the page navigates away mid-command, the old document never answers.
  // Notice the new document finishing its load and give up instead of hanging.
  let onUpdated;
  let startedLoading = false;
  const navigatedAway = new Promise((_, reject) => {
    onUpdated = (id, change) => {
      if (id !== tabId) return;
      if (change.status === 'loading') startedLoading = true;
      if (change.status !== 'complete' || !startedLoading) return;
      setTimeout(() => reject(new Error(`The page navigated while "${action}" was running. Check the page and try again.`)), 750);
    };
  });
  navigatedAway.catch(() => {});
  browser.tabs.onUpdated.addListener(onUpdated);
  try {
    response = await Promise.race([browser.tabs.sendMessage(tabId, message, { frameId: 0 }), navigatedAway]);
  } catch (err) {
    if (/navigated while/.test(String(err && err.message))) throw err;
    // Page was open before the extension loaded, or is restricted.
    try {
      for (const file of ['/markdown.js', '/content.js', '/overlay.js']) {
        await browser.tabs.executeScript(tabId, { file, frameId: 0, runAt: 'document_start' });
      }
      response = await browser.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      throw unscriptable(tab);
    }
  } finally {
    browser.tabs.onUpdated.removeListener(onUpdated);
  }
  if (!response) throw unscriptable(tab);
  // Claude using a tab turns on console/network capture for it; the user
  // explaining or commenting on a page does not.
  if (claim) {
    claimed.add(tabId);
    if (!response.capturing) {
      browser.tabs.sendMessage(tabId, { action: 'captureConsole' }, { frameId: 0 }).catch(() => {});
    }
  }
  if (response.error !== undefined) throw new Error(response.error);
  return response.result;
}

function filterBuffer(list, { pattern, limit = 100 }, field) {
  let out = list;
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    out = out.filter((entry) => re.test(entry[field]));
  }
  return out.slice(-limit);
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 23);

// ------------------------------------------------------------------ commands

const pageAction = (action) => (params) => inPage(params.tabId, action, params);

const handlers = {
  async hello() {
    const self = await browser.management.getSelf();
    return { version: browser.runtime.getManifest().version, development: self.installType === 'development', base: browser.runtime.getURL('') };
  },

  async tabs_list() {
    const [tabs, focused] = await Promise.all([
      browser.tabs.query({}),
      browser.windows.getLastFocused().catch(() => null),
    ]);
    // "current" marks the one tab the user is looking at: the active tab of
    // the window they last used.
    return tabs.map((tab) => ({ ...describeTab(tab), current: !!focused && tab.active && tab.windowId === focused.id }));
  },

  async tab_create({ url, active = true, windowId, plain = false }) {
    const options = { url: url ? guardUrl(normalizeUrl(url)) : undefined, active };
    // Zen Spaces can each have their own container (separate logins). Open the
    // tab in the same container as the page the user is on, so it is signed in
    // the same way.
    try {
      const [beside] = await browser.tabs.query(typeof windowId === 'number' ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
      if (beside && beside.cookieStoreId && !plain) options.cookieStoreId = beside.cookieStoreId;
    } catch {}
    let created;
    try {
      // In the window the conversation belongs to, not whichever is in front.
      created = await browser.tabs.create(typeof windowId === 'number' ? { ...options, windowId } : options);
    } catch (err) {
      // That window has been closed, or the container cannot be used there.
      delete options.cookieStoreId;
      created = await browser.tabs.create(options);
    }
    const tabId = created.id;
    claimed.add(tabId);
    // A new tab reports "complete" for its initial blank document before the
    // real URL starts loading, so poll until the real page is in.
    const deadline = Date.now() + 30000;
    let tab = created;
    let outcome = 'timeout';
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      tab = await browser.tabs.get(tabId);
      if (tab.status === 'complete' && (!url || tab.url !== 'about:blank')) {
        outcome = 'complete';
        break;
      }
    }
    return { ...describeTab(tab), load: outcome };
  },

  async tab_discard({ tabId }) {
    await browser.tabs.discard(tabId);
    return `Unloaded tab ${tabId}`;
  },

  async tab_close({ tabId }) {
    await browser.tabs.remove(tabId);
    return `Closed tab ${tabId}`;
  },

  async navigate({ tabId, url }) {
    await guard(tabId);
    if (!['back', 'forward', 'reload'].includes(url)) guardUrl(normalizeUrl(url));
    claimed.add(tabId);
    const { outcome } = await withLoad(async () => {
      if (url === 'back') await browser.tabs.goBack(tabId);
      else if (url === 'forward') await browser.tabs.goForward(tabId);
      else if (url === 'reload') await browser.tabs.reload(tabId);
      else await browser.tabs.update(tabId, { url: normalizeUrl(url) });
      return tabId;
    });
    return { ...describeTab(await browser.tabs.get(tabId)), load: outcome };
  },

  read_page: pageAction('read_page'),
  get_page_text: pageAction('get_page_text'),
  find: pageAction('find'),
  click: pageAction('click'),
  hover: pageAction('hover'),
  type: pageAction('type'),
  key: pageAction('key'),
  form_input: pageAction('form_input'),
  scroll: pageAction('scroll'),
  annotate: pageAction('annotate'),
  clear_annotations: pageAction('clear_annotations'),
  get_selection: pageAction('get_selection'),
  show_card: pageAction('show_card'),
  close_cards: pageAction('close_cards'),
  // Any other in-page action by name; used by the end-to-end tests.
  page_action: ({ tabId, action, params }) => inPage(tabId, action, params, { claim: false }),

  // Polled from here rather than inside the page, so a wait survives the page
  // navigating underneath it (the usual reason to wait in the first place).
  async wait_for({ tabId, text, selector, seconds = 10 }) {
    const limit = Math.min(Math.max(seconds, 0), 30) * 1000;
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    if (!text && !selector) {
      await pause(limit);
      return `Waited ${limit / 1000}s.`;
    }
    const what = selector ? `selector ${selector}` : `text "${text}"`;
    const start = Date.now();
    for (;;) {
      const found = await Promise.race([
        inPage(tabId, 'has', { text, selector }).catch(() => false), // mid-navigation: not there yet
        pause(2000).then(() => false),
      ]);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (found) return `Found ${what} after ${elapsed}s.`;
      if (Date.now() - start >= limit) throw new Error(`${what} did not appear within ${limit / 1000}s.`);
      await pause(250);
    }
  },

  async screenshot({ tabId }) {
    await guard(tabId);
    const tab = await browser.tabs.get(tabId);
    const options = { format: 'jpeg', quality: 80, scale: 1 };
    let dataUrl;
    let method = 'captureTab';
    try {
      // scale 1 => image pixels are CSS pixels, so they double as click coordinates.
      dataUrl = await Promise.race([
        browser.tabs.captureTab(tabId, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('captureTab did not respond')), 6000)),
      ]);
    } catch (err) {
      // Fall back to capturing whatever the window shows, which needs the tab in front.
      method = 'captureVisibleTab after: ' + err.message;
      try {
        if (!tab.active) await browser.tabs.update(tabId, { active: true });
        dataUrl = await Promise.race([
          browser.tabs.captureVisibleTab(tab.windowId, options),
          new Promise((_, reject) => setTimeout(() => reject(new Error('captureVisibleTab did not respond')), 6000)),
        ]);
      } catch (err2) {
        throw new Error(`Could not capture tab ${tabId}: ${err.message}; ${err2.message}`);
      }
    }
    const viewport = await inPage(tabId, 'viewport').catch(() => ({}));
    return {
      mimeType: 'image/jpeg',
      data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      width: viewport.width ?? tab.width,
      height: viewport.height ?? tab.height,
      url: tab.url,
      method,
    };
  },

  async javascript({ tabId, code }) {
    const result = await inPage(tabId, 'javascript', { code });
    if (!result.blockedByCsp) return result.value;
    // The page's Content-Security-Policy forbids eval, so the usual route is
    // closed. Run the code in the page's own world through the scripting API
    // instead: there it is an ordinary page script, with the page's variables
    // and none of the add-on's powers. (It must never be run in the add-on's
    // content-script world, where it would have the add-on's messaging and
    // requests that skip the page's cross-origin rules.)
    return runInPageWorld(tabId, code);
  },

  async console_messages({ tabId, pattern, onlyErrors, limit, clear }) {
    await inPage(tabId, 'flushConsole').catch(() => {});
    let list = consoleLogs.get(tabId) || [];
    if (onlyErrors) list = list.filter((e) => e.level === 'error' || e.level === 'exception');
    const shown = filterBuffer(list, { pattern, limit }, 'text');
    if (clear) consoleLogs.delete(tabId);
    if (!shown.length) {
      return 'No console messages captured. Capture begins the first time Claude uses a tab; reload the page to catch messages from startup.';
    }
    return shown.map((e) => `[${clock(e.time)}] ${e.level}: ${e.text}`).join('\n');
  },

  async network_requests({ tabId, pattern, limit, clear }) {
    const shown = filterBuffer(requests.get(tabId) || [], { pattern, limit }, 'url');
    if (clear) requests.delete(tabId);
    if (!shown.length) {
      return 'No network requests recorded. Recording begins the first time Claude uses a tab; reload the page to see its requests.';
    }
    return shown.map((r) => `[${clock(r.time)}] ${r.status} ${r.method} ${r.type} ${r.url}`).join('\n');
  },

  async resize_window({ tabId, width, height }) {
    const tab = await browser.tabs.get(tabId);
    await browser.windows.update(tab.windowId, { width, height });
    return `Resized window to ${width}x${height}`;
  },
};

// ------------------------------------------------- console + network capture

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'status') {
    keepControl();
    return Promise.resolve({ sessions: sessionCount(), panel: !!control && control.readyState === WebSocket.OPEN });
  }
  if (msg.type === 'chat_port') return chatPort();
  if (msg.type === 'comment_mode') {
    return browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab && userAction(tab.id, 'comment_mode'));
  }
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined || sender.frameId !== 0) return;
  if (msg.type === 'hello') return Promise.resolve({ claimed: claimed.has(tabId) });
  if (msg.type === 'console') for (const entry of msg.entries) push(consoleLogs, tabId, entry);
});

const record = (status) => (details) => {
  if (!claimed.has(details.tabId)) return; // only tabs Claude is using
  push(requests, details.tabId, {
    method: details.method,
    url: details.url,
    type: details.type,
    status: status(details),
    time: details.timeStamp,
  });
};
browser.webRequest.onCompleted.addListener(record((d) => d.statusCode), { urls: ['<all_urls>'] });
browser.webRequest.onErrorOccurred.addListener(record((d) => `FAILED(${d.error})`), { urls: ['<all_urls>'] });

browser.tabs.onRemoved.addListener((tabId) => {
  claimed.delete(tabId);
  consoleLogs.delete(tabId);
  requests.delete(tabId);
});

// --------------------------------------- explain and comments (chat server)

// The on-page explain card and comment pins talk to the chat panel server.
// A content script opens a port; this relays it to the server over a
// WebSocket, adding which tab it came from.
const CHAT_PORT = 47810;
// The tests run their own chat server on another port, so that they never take
// over the panel the user has open. Only a temporarily loaded (development)
// copy of the add-on looks for it; an installed copy always uses the real one.
const TEST_CHAT_PORT = 47820;
let development = null;
async function chatPort() {
  if (development === null) development = (await browser.management.getSelf()).installType === 'development';
  if (!development) return CHAT_PORT;
  try {
    const res = await fetch(`http://${HOST}:${TEST_CHAT_PORT}/ping`, { cache: 'no-store' });
    if ((await res.json()).app === 'claude-for-zen-chat') return TEST_CHAT_PORT;
  } catch {}
  return CHAT_PORT;
}
const CHAT_DOWN =
  'The Claude for Zen chat server is not running. Start it with "npm run chat" in the project folder (or run scripts/autostart.ps1 once to start it at login).';

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat') return;
  // Only the content script in a tab's top frame may relay to the chat server:
  // not an add-on page that a website has framed, and not a sub-frame.
  if (!port.sender || !port.sender.tab || port.sender.frameId !== 0 || String(port.sender.url || '').startsWith(browser.runtime.getURL(''))) {
    port.disconnect();
    return;
  }
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  let ws = null;
  let queue = [];
  let closed = false;
  const tell = (msg) => {
    if (closed) return;
    try {
      port.postMessage(msg);
    } catch {}
  };
  const windowId = port.sender && port.sender.tab ? port.sender.tab.windowId : null;
  const forward = (msg) => ws.send(JSON.stringify({ ...msg, tabId, windowId }));

  (async () => {
    // Probe first: see probe() above for why WebSockets are not opened blind.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2500);
    let up = false;
    try {
      port.chatPort = await chatPort();
      const res = await fetch(`http://${HOST}:${port.chatPort}/ping`, { cache: 'no-store', signal: abort.signal });
      up = (await res.json()).app === 'claude-for-zen-chat';
    } catch {}
    clearTimeout(timer);
    if (closed) return;
    if (!up) return tell({ type: 'error', text: CHAT_DOWN });
    ws = new WebSocket(`ws://${HOST}:${port.chatPort}/ext`);
    ws.onopen = () => {
      queue.forEach(forward);
      queue = null;
    };
    ws.onmessage = (event) => tell(JSON.parse(event.data));
    ws.onerror = () => tell({ type: 'error', text: CHAT_DOWN });
    ws.onclose = () => {
      if (queue) tell({ type: 'error', text: CHAT_DOWN });
    };
  })();

  port.onMessage.addListener((msg) => (queue ? queue.push(msg) : ws.readyState === WebSocket.OPEN && forward(msg)));
  port.onDisconnect.addListener(() => {
    closed = true;
    if (ws) ws.close();
  });
});

/** Run an overlay action in a tab the user is in (not on Claude's behalf). */
async function userAction(tabId, action) {
  try {
    await inPage(tabId, action, {}, { claim: false });
  } catch {
    // restricted page: nothing to do
  }
}

// A standing connection to the chat server, so the chat panel's Comment button
// can start comment mode in the page beside it. Probed over HTTP first, like
// the MCP connections, and retried quietly while the server is not running.
let control = null;
let controlPort = CHAT_PORT;
async function keepControl() {
  if (control) return;
  try {
    controlPort = await chatPort();
    const res = await fetch(`http://${HOST}:${controlPort}/ping`, { cache: 'no-store' });
    if ((await res.json()).app !== 'claude-for-zen-chat' || control) return;
  } catch {
    return;
  }
  const ws = new WebSocket(`ws://${HOST}:${controlPort}/ext`);
  control = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'control', version: browser.runtime.getManifest().version }));
  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'approve_userscripts') {
      // Only Violentmonkey's own connect address; Violentmonkey takes it from there and shows its Approve button.
      if (typeof msg.url === 'string' && /^https:\/\/violentmonkey\.github\.io\/mcp_connect[./?]/.test(msg.url)) {
        browser.tabs.create({ url: msg.url, active: true }).catch(() => {});
      }
      return;
    }
    if (msg.type === 'attention') {
      waiting = Number(msg.waiting) || 0;
      updateBadge();
      return;
    }
    if (msg.type === 'where') {
      // Which tab the user is looking at right now, for the panel they just typed in.
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      const windows = await browser.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
      ws.send(JSON.stringify({ type: 'where', id: msg.id, tab: tab ? { ...describeTab(tab), incognito: tab.incognito } : null, windows: windows.length }));
      return;
    }
    if (msg.type !== 'comment_mode') return;
    // The panel's window if it is known and still open, else the window in front.
    let [tab] = typeof msg.windowId === 'number' ? await browser.tabs.query({ active: true, windowId: msg.windowId }).catch(() => []) : [];
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) userAction(tab.id, 'comment_mode');
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (control === ws) control = null;
    waiting = 0;
    updateBadge();
  };
}
keepControl();
setInterval(keepControl, 3000);

browser.menus.create({ id: 'explain', title: 'Explain with Claude', contexts: ['selection'] });
browser.menus.create({ id: 'comment', title: 'Comment on this for Claude', contexts: ['page', 'selection', 'link', 'image', 'video', 'audio', 'editable'] });
browser.menus.onClicked.addListener((info, tab) => {
  if (!tab || info.frameId) return;
  if (info.menuItemId === 'explain') userAction(tab.id, 'explain_selection');
  if (info.menuItemId === 'comment') userAction(tab.id, 'comment_here');
});

browser.commands.onCommand.addListener(async (command) => {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  if (command === 'comment') userAction(tab.id, 'comment_mode');
  if (command === 'explain') userAction(tab.id, 'explain_selection');
});
