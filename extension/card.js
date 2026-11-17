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
//
// SECURITY: this page is web-accessible, so any website can frame it. It must
// never run anything unless it is sandboxed. Framed WITHOUT the sandbox
// attribute it would be a real add-on page, and running posted HTML would hand
// the embedding website the add-on's identity. Hence the check below, which
// comes before everything else.

const sandboxed = self.origin === 'null' && typeof browser === 'undefined' && typeof chrome === 'undefined';

if (sandboxed) {
  // The overlay puts a one-off token in the address; the embedding page cannot
  // read a cross-origin frame's address, and the token is never sent back out.
  const token = location.hash.slice(1);
  let drawn = false;

  const draw = async (html) => {
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
    return { ok: true, errors: errors.slice(0, 3), empty: !document.body.textContent.trim() && !document.body.querySelector('svg,canvas,img,video,table,input,button'), contentHeight: Math.round(Math.max(box.height, document.documentElement.scrollHeight)) };
  };

  addEventListener('message', (event) => {
    const data = event.data;
    const port = event.ports && event.ports[0];
    // Only the overlay knows the token. The outcome goes back over the private
    // port it sent, never to the page.
    if (drawn || event.source !== parent || !port || !token || !data || data.claudeForZenCard !== token || typeof data.html !== 'string') return;
    drawn = true;
    draw(data.html)
      .catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err) }))
      .then((result) => port.postMessage(result));
  });
  // Says only that the frame is listening; carries nothing secret.
  parent.postMessage({ claudeForZenCard: 'ready' }, '*');
}
