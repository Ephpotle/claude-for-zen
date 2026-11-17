// Draws one generated card.
//
// The page's overlay loads this extension page in a sandboxed frame (so it has
// an opaque origin and none of the add-on's powers) and posts the card's HTML
// to it. Being an extension page, it is exempt from the host site's
// Content-Security-Policy. The HTML used to be framed from the local server
// instead, but browsers now refuse to let a public website's frames load from
// 127.0.0.1 (Local Network Access), which left every card blank.
//
// This document's own policy (card.html) allows no network at all and no
// inline script. So the card's inline scripts and on* handlers are collected
// and run here with eval, which that policy does allow: one eval for all of
// them, so that they share top-level let/const as separate scripts would.

const token = location.hash.slice(1);
let drawn = false;

const report = (message) => parent.postMessage({ claudeForZenCard: token, ...message }, '*');

async function draw(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // Scripts from a parsed document never run; collect them to run in order afterwards.
  const scripts = [];
  const unsupported = [];
  for (const old of [...parsed.querySelectorAll('script')]) {
    const type = (old.getAttribute('type') || '').trim().toLowerCase();
    const classic = !type || type === 'text/javascript' || type === 'application/javascript';
    if (!classic && type !== 'module') continue; // data blocks (JSON and the like) stay in the page
    if (old.src) unsupported.push('an external script (cards have no network)');
    else if (type === 'module') unsupported.push('a <script type="module"> (use an ordinary script)');
    else scripts.push(old.textContent);
    old.remove();
  }
  // onclick="…" and friends are inline script too; turn them into listeners.
  let handlers = '';
  let n = 0;
  for (const el of parsed.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (!/^on[a-z]+$/i.test(attr.name)) continue;
      const id = String(++n);
      el.setAttribute('data-cfz-handler', ((el.getAttribute('data-cfz-handler') || '') + ' ' + id).trim());
      handlers += `document.querySelector('[data-cfz-handler~="${id}"]').addEventListener(${JSON.stringify(attr.name.slice(2).toLowerCase())}, function (event) {\n${attr.value}\n});\n`;
      el.removeAttribute(attr.name);
    }
  }
  for (const attr of parsed.documentElement.attributes) document.documentElement.setAttribute(attr.name, attr.value);
  for (const node of [...parsed.head.childNodes]) {
    if (node.nodeName === 'META' && node.httpEquiv) continue; // this document's policy is not the card's to change
    document.head.append(document.adoptNode(node));
  }
  document.body.replaceWith(document.adoptNode(parsed.body));

  const errors = [];
  const onError = (event) => errors.push(String(event.message || event.reason || 'script error'));
  // Something the card tried that this document's policy refused (a network request, usually).
  const onBlocked = (event) => errors.push(`blocked by the card's security policy: ${event.violatedDirective} ${String(event.blockedURI).slice(0, 80)}`);
  addEventListener('error', onError);
  addEventListener('unhandledrejection', onError);
  document.addEventListener('securitypolicyviolation', onBlocked);
  for (const what of new Set(unsupported)) errors.push(`left out ${what}`);
  const code = scripts.concat(handlers).filter(Boolean).join('\n;\n');
  if (code) {
    try {
      (0, eval)(code); // indirect: runs at global scope, like a script element
    } catch (err) {
      errors.push(String(err && err.message ? err.message : err));
    }
  }
  // The real load events fired before the card arrived.
  document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
  dispatchEvent(new Event('load'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  removeEventListener('error', onError);
  removeEventListener('unhandledrejection', onError);
  document.removeEventListener('securitypolicyviolation', onBlocked);
  const box = document.body.getBoundingClientRect();
  report({ ok: true, errors: errors.slice(0, 3), empty: !document.body.textContent.trim() && !document.body.querySelector('svg,canvas,img,video,table,input,button'), contentHeight: Math.round(Math.max(box.height, document.documentElement.scrollHeight)) });
}

addEventListener('message', (event) => {
  if (drawn || event.source !== parent || !event.data || event.data.claudeForZenCard !== token || typeof event.data.html !== 'string') return;
  drawn = true;
  draw(event.data.html).catch((err) => report({ ok: false, error: String(err && err.message ? err.message : err) }));
});
report({ ready: true });
