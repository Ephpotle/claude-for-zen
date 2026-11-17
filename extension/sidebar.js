// The add-on's own sidebar: the chat panel from the local chat server, shown
// under the add-on's name instead of as a custom provider address.
let CHAT = 'http://127.0.0.1:47810';
const down = document.getElementById('down');

async function show() {
  let up = false;
  try {
    CHAT = 'http://127.0.0.1:' + (await browser.runtime.sendMessage({ type: 'chat_port' }));
    const res = await fetch(CHAT + '/ping', { cache: 'no-store' });
    up = (await res.json()).app === 'claude-for-zen-chat';
  } catch {}
  down.hidden = up;
  document.querySelector('iframe')?.remove();
  if (!up) return;
  const frame = document.createElement('iframe');
  frame.src = CHAT + '/';
  document.body.append(frame);
}

document.getElementById('retry').addEventListener('click', show);
show();
