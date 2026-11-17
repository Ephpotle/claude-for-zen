// Claude for Zen — chat panel page.

const token = document.querySelector('meta[name=token]').content;
const log = document.getElementById('log');
const empty = document.getElementById('empty');
const offline = document.getElementById('offline');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const action = document.getElementById('action');

let socket = null;
let busy = false;
let thinking = null; // "Working…" line shown until Claude's first output of a turn
const nodes = new Map(); // item id -> element
const texts = new Map(); // item id -> raw markdown
const items = new Map(); // item id -> latest copy of the item

const markdown = globalThis.claudeForZenMarkdown; // from /markdown.js, shared with the add-on

// ------------------------------------------------------------------- render

const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
function keepInView(wasNear) {
  if (wasNear) log.scrollTop = log.scrollHeight;
}

function setThinking(on) {
  if (on && !thinking) {
    thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.textContent = 'Working…';
    log.append(thinking);
  } else if (!on && thinking) {
    thinking.remove();
    thinking = null;
  }
}

function toolLine(el, item) {
  el.className = item.state;
  el.textContent = item.label;
  if (item.state === 'failed' && item.detail) {
    const detail = document.createElement('small');
    detail.textContent = item.detail;
    el.append(detail);
  }
}

const ASK_OUTCOME = { allowed: 'Allowed', denied: 'Not allowed', cancelled: 'No longer needed' };

/** A request for permission: what Claude wants to do, and Allow / Don't allow. */
function askBlock(el, item) {
  el.className = item.state === 'waiting' ? 'ask' : 'ask settled';
  el.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = item.title;
  const body = document.createElement('pre');
  body.textContent = item.body;
  el.append(title, body);
  if (item.state !== 'waiting') {
    const outcome = document.createElement('em');
    outcome.textContent = ASK_OUTCOME[item.state] || item.state;
    el.append(outcome);
    return;
  }
  const buttons = document.createElement('div');
  for (const [label, allow] of [['Allow', true], ["Don't allow", false]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (allow) button.className = 'allow';
    button.addEventListener('click', () => socket.send(JSON.stringify({ type: 'answer', id: item.id, allow })));
    buttons.append(button);
  }
  el.append(buttons);
}

function addItem(item) {
  const wasNear = nearBottom();
  empty.hidden = true;
  setThinking(false);
  let el;
  items.set(item.id, { ...item });
  if (item.type === 'ask') {
    el = document.createElement('div');
    askBlock(el, item);
    log.append(el);
  } else if (item.type === 'tool') {
    // Consecutive steps share one trail.
    let trail = log.lastElementChild;
    if (!trail || !trail.classList.contains('trail')) {
      trail = document.createElement('ol');
      trail.className = 'trail';
      log.append(trail);
    }
    el = document.createElement('li');
    toolLine(el, item);
    trail.append(el);
  } else if (item.type === 'figure') {
    // A drawing from Claude, in a frame that can run its own scripts but reach nothing else.
    el = document.createElement('figure');
    if (item.title) {
      const caption = document.createElement('figcaption');
      caption.textContent = item.title;
      el.append(caption);
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.title = item.title || 'Figure from Claude';
    frame.style.height = (item.height || 320) + 'px';
    frame.src = `/figure/${conversationId}/${item.id}`;
    el.append(frame);
    log.append(el);
  } else {
    el = document.createElement('div');
    el.className = item.type;
    if (item.type === 'text') {
      texts.set(item.id, item.text);
      el.innerHTML = markdown(item.text);
    } else {
      el.textContent = item.text;
      // Pictures sent with a message: small previews, or a note where none was kept.
      if (item.type === 'user' && item.pictures) {
        const strip = document.createElement('div');
        strip.className = 'pictures';
        for (const src of item.previews || []) {
          const img = document.createElement('img');
          img.src = src;
          img.alt = 'Picture you sent';
          strip.append(img);
        }
        if (!strip.children.length) strip.textContent = `${item.pictures} picture${item.pictures === 1 ? '' : 's'}`;
        el.append(strip);
      }
    }
    log.append(el);
  }
  nodes.set(item.id, el);
  if (item.type === 'user' && busy) setThinking(true);
  keepInView(wasNear || item.type === 'user');
}

function onEvent(event) {
  // Only these carry the conversation's id; on other events `id` is an item.
  if ((event.type === 'history' || event.type === 'reset') && event.id) rememberSeat(event.id);
  if (event.type === 'history') {
    clearLog();
    event.events.forEach(addItem);
    setBusy(event.busy);
    if (event.busy) setThinking(true);
    if (event.settings) showSettings(event.settings);
    log.scrollTop = log.scrollHeight;
  } else if (event.type === 'item') {
    addItem(event.item);
  } else if (event.type === 'delta') {
    const el = nodes.get(event.id);
    if (!el) return;
    const wasNear = nearBottom();
    const text = texts.get(event.id) + event.text;
    texts.set(event.id, text);
    el.innerHTML = markdown(text);
    keepInView(wasNear);
  } else if (event.type === 'update') {
    const el = nodes.get(event.id);
    const item = items.get(event.id);
    if (!el || !item) return;
    Object.assign(item, event.patch);
    if (item.type === 'tool') toolLine(el, item);
    else if (item.type === 'ask') askBlock(el, item);
  } else if (event.type === 'busy') {
    setBusy(event.busy);
  } else if (event.type === 'reset') {
    clearLog();
  } else if (event.type === 'settings') {
    showSettings(event.settings, event.problem);
  } else if (event.type === 'conversations') {
    showConversations(event.list, event.current);
  } else if (event.type === 'notice') {
    showNotice(event.text);
  }
}

// A drawing reports its own height (it is sandboxed, so it cannot be measured from here).
window.addEventListener('message', (event) => {
  const height = event.data && event.data.claudeForZenFigure;
  if (typeof height !== 'number') return;
  for (const frame of document.querySelectorAll('figure iframe')) {
    if (frame.contentWindow !== event.source) continue;
    const wasNear = nearBottom();
    frame.style.height = Math.max(60, Math.min(height, 1200)) + 'px';
    keepInView(wasNear);
  }
});

// ----------------------------------------------------------------- settings

const settingsForm = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const folder = document.getElementById('folder');
const problem = document.getElementById('settings-problem');
const ACCESS_LABEL = { browser: 'Access', ask: 'Access: asks first', full: 'Access: no asking' };
const ACCESS_NOTE = {
  browser: 'Pages and tabs in Zen. Nothing on your computer.',
  ask: 'Files and commands too. Each command or file change waits for your OK.',
  full: 'Runs commands and changes files straight away. A page that tricks Claude could then reach your files.',
};
function showAccessNote(access) {
  const note = document.getElementById('access-note');
  note.textContent = ACCESS_NOTE[access] || '';
  note.className = access === 'full' ? 'warn' : '';
  document.getElementById('folder-row').hidden = access === 'browser';
}

/** "claude-fable-5-2" reads as "Fable 5.2". */
function modelName(id) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (!match) return id;
  return match[1][0].toUpperCase() + match[1].slice(1) + ' ' + match[2] + (match[3] ? '.' + match[3] : '');
}

let theme = document.documentElement.dataset.theme || '';

function showSettings(settings, trouble) {
  theme = settings.theme || '';
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('#looks button')) button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
  settingsForm.elements.access.value = settings.access;
  document.getElementById('access-all').checked = !!settings.accessForAll;
  document.getElementById('spaces').checked = !!settings.spaces;
  document.getElementById('scripts').checked = !!settings.scripts;
  document.getElementById('script-updates').checked = !!settings.scriptUpdates;
  document.getElementById('script-updates-row').hidden = !settings.scripts;
  document.getElementById('model').value = settings.model || '';
  document.querySelector('#model option[value=""]').textContent = settings.defaultModel ? `Default (${modelName(settings.defaultModel)})` : 'Default';
  document.getElementById('effort').value = settings.effort || '';
  if (document.activeElement !== folder || !trouble) folder.value = settings.folder || '';
  showAccessNote(settings.access);
  settingsToggle.textContent = ACCESS_LABEL[settings.access];
  settingsToggle.className = settings.access === 'browser' ? '' : settings.access === 'full' ? 'computer full' : 'computer';
  problem.hidden = !trouble;
  problem.textContent = trouble || '';
}

function saveSettings() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'settings', access: settingsForm.elements.access.value, accessForAll: document.getElementById('access-all').checked, theme, folder: folder.value, spaces: document.getElementById('spaces').checked, scripts: document.getElementById('scripts').checked, scriptUpdates: document.getElementById('script-updates').checked, model: document.getElementById('model').value, effort: document.getElementById('effort').value }));
}

settingsToggle.addEventListener('click', () => {
  settingsForm.hidden = !settingsForm.hidden;
  settingsToggle.setAttribute('aria-expanded', String(!settingsForm.hidden));
});
settingsForm.addEventListener('change', () => {
  showAccessNote(settingsForm.elements.access.value);
  saveSettings();
});
// The look: applied at once here, saved so that every window follows.
document.getElementById('looks').addEventListener('click', (event) => {
  if (event.target.tagName !== 'BUTTON') return;
  theme = event.target.dataset.theme;
  document.documentElement.dataset.theme = theme;
  saveSettings();
});
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveSettings();
});

// ------------------------------------------------------------------ comment

const notice = document.getElementById('notice');
let noticeTimer = null;
function showNotice(text) {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 8000);
}

// Starts comment mode in the page beside the panel: the next click there pins a note.
document.getElementById('comment').addEventListener('click', () => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'comment_mode' }));
});

// ------------------------------------------------------------------ history

const historyPanel = document.getElementById('history');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
let currentId = null;

function when(ms) {
  const date = new Date(ms);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400000);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

function showConversations(list, current) {
  historyList.replaceChildren();
  document.getElementById('history-empty').hidden = list.length > 0;
  for (const entry of list) {
    const row = document.createElement('li');
    if (entry.id === current) row.className = 'current';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    const title = document.createElement('span');
    title.textContent = entry.title;
    const meta = document.createElement('small');
    meta.textContent = `${when(entry.updatedAt)}, ${entry.messages} message${entry.messages === 1 ? '' : 's'}${entry.elsewhere ? ', open in another window' : ''}`;
    open.append(title, meta);
    open.addEventListener('click', () => {
      socket.send(JSON.stringify({ type: 'open', id: entry.id }));
      toggleHistory(false);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete';
    remove.textContent = '×';
    remove.title = 'Delete this conversation';
    remove.addEventListener('click', () => {
      // Deleting cannot be undone, so the first click only arms the button.
      if (remove.dataset.armed) return socket.send(JSON.stringify({ type: 'delete', id: entry.id }));
      remove.dataset.armed = '1';
      remove.textContent = 'Delete?';
      remove.style.opacity = 1;
      remove.style.fontSize = '12px';
    });
    row.append(open, remove);
    historyList.append(row);
  }
}

function toggleHistory(show = historyPanel.hidden) {
  historyPanel.hidden = !show;
  historyToggle.setAttribute('aria-expanded', String(show));
  if (show && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'list' }));
}
historyToggle.addEventListener('click', () => toggleHistory());

function clearLog() {
  nodes.clear();
  items.clear();
  texts.clear();
  thinking = null;
  log.replaceChildren(empty);
  empty.hidden = false;
}

function setBusy(value) {
  busy = value;
  action.textContent = busy ? 'Stop' : 'Send';
  action.classList.toggle('stop', busy);
  refreshAction();
  if (!busy) setThinking(false);
}

function refreshAction() {
  action.disabled = !socket || socket.readyState !== WebSocket.OPEN || (!busy && !input.value.trim() && !attached.length);
}

// ------------------------------------------------------------------ pictures

// Pictures waiting to go with the next message: pasted or dropped onto the box.
let attached = []; // { mediaType, data (base64), preview (small data URL) }
const attachments = document.getElementById('attachments');
const MAX_PICTURES = 4;

function showAttached() {
  attachments.replaceChildren();
  attachments.hidden = attached.length === 0;
  attached.forEach((picture, i) => {
    const item = document.createElement('span');
    const img = document.createElement('img');
    img.src = picture.preview;
    img.alt = 'Picture to send';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove this picture';
    remove.addEventListener('click', () => {
      attached.splice(i, 1);
      showAttached();
    });
    item.append(img, remove);
    attachments.append(item);
  });
  refreshAction();
}

/** Draw the picture at most `side` pixels on its longer edge and return it as a data URL. */
function scaled(image, side, type, quality) {
  const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality);
}

async function attach(file) {
  if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
  if (attached.length >= MAX_PICTURES) return showNotice(`At most ${MAX_PICTURES} pictures per message.`);
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('That picture could not be read.'));
    image.src = url;
  });
  // Large screenshots are scaled to what Claude reads anyway, which also keeps the message small.
  const big = Math.max(image.naturalWidth, image.naturalHeight) > 1568 || url.length > 4_000_000;
  const sent = big ? scaled(image, 1568, 'image/jpeg', 0.9) : url;
  attached.push({
    mediaType: sent.slice(5, sent.indexOf(';')),
    data: sent.slice(sent.indexOf(',') + 1),
    preview: scaled(image, 240, 'image/jpeg', 0.7),
  });
  showAttached();
}

function attachAll(files) {
  for (const file of files) attach(file).catch((err) => showNotice(err.message));
}

input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return; // ordinary text paste
  event.preventDefault();
  attachAll(files);
});
form.addEventListener('dragover', (event) => {
  if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault();
});
form.addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  attachAll(files);
});

// ------------------------------------------------------------------- actions

function send(text) {
  text = text.trim();
  if ((!text && !attached.length) || busy || !socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ type: 'send', text, images: attached }));
  attached = [];
  showAttached();
  setBusy(true); // the message itself comes back from the server as an item
  return true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) {
    socket.send(JSON.stringify({ type: 'stop' }));
  } else if (send(input.value)) {
    input.value = '';
    resize();
  }
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) form.requestSubmit();
  }
});

function resize() {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
  refreshAction();
}
input.addEventListener('input', resize);

document.getElementById('new').addEventListener('click', () => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'reset' }));
  input.focus();
});

empty.addEventListener('click', (event) => {
  if (event.target.tagName === 'BUTTON') send(event.target.textContent);
});

// ---------------------------------------------------------------- connection

// Zen's chat sidebar hands over prompts (e.g. "summarise this page" from its
// menus) as ?q=…; send it once, then drop it so a reload doesn't repeat it.
let pending = new URLSearchParams(location.search).get('q');
if (pending) history.replaceState(null, '', location.pathname);

// Each window's panel has its own conversation. The id is kept for this panel
// only (not shared between windows), so a reload comes back to the same one.
let conversationId = '';
function rememberSeat(id) {
  conversationId = id;
  try {
    sessionStorage.setItem('seat', id);
  } catch {}
}
function seat() {
  try {
    return sessionStorage.getItem('seat') || '';
  } catch {
    return '';
  }
}
// Tell the server this is the panel in use, so a comment pinned on the page lands here.
const touch = () => socket && socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'touch' }));
window.addEventListener('focus', touch);
document.addEventListener('pointerdown', touch);

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws?token=${token}&seat=${seat()}`);
  socket.onopen = () => {
    offline.hidden = true;
    refreshAction();
  };
  socket.onmessage = (message) => {
    const event = JSON.parse(message.data);
    onEvent(event);
    if (event.type === 'history' && pending) {
      // Put it in the box; never send it. Any website can make a link to this page with
      // a ?q= of its choosing, so sending would let it speak to Claude as the user.
      const prompt = pending;
      pending = null;
      input.value = prompt;
      input.focus();
      resize();
    }
  };
  socket.onclose = () => {
    offline.hidden = false;
    refreshAction();
    // A restarted server issues a new token, so reload the page to get it.
    setTimeout(async () => {
      try {
        await fetch('/', { cache: 'no-store' });
        location.reload();
      } catch {
        connect();
      }
    }, 1500);
  };
}

connect();
resize();
