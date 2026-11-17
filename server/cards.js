// Hosting for "cards": small self-contained HTML documents (diagrams,
// animations) that Claude generates and the extension shows on a page.
//
// A card is served from localhost under a random ID and locked down by its
// response headers: scripts and styles may run inline, but the document gets
// an opaque origin and no network access, so generated content cannot read the
// page it sits on, reach this server, or send anything anywhere.

import { randomBytes } from 'node:crypto';

const MAX_CARDS = 40;
const MAX_BYTES = 2 * 1024 * 1024;

const CARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  'sandbox allow-scripts',
].join('; ');

/** A bare fragment becomes a document that follows the light or dark theme. */
export function asDocument(html) {
  html = String(html);
  return /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head><body>${html}</body></html>`;
}

/** Send generated HTML locked down: inline scripts and styles only, opaque origin, no network. */
export function sendCard(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CARD_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(asDocument(html));
}

export function createCardStore() {
  const cards = new Map(); // id -> html

  return {
    /** Store a document; returns its path, e.g. /card/3f9a… */
    add(html) {
      html = String(html);
      if (Buffer.byteLength(html) > MAX_BYTES) throw new Error('That card is too large (limit 2 MB).');
      if (!/<html[\s>]/i.test(html)) {
        html = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head><body>${html}</body></html>`;
      }
      const id = randomBytes(16).toString('hex');
      cards.set(id, html);
      while (cards.size > MAX_CARDS) cards.delete(cards.keys().next().value);
      return `/card/${id}`;
    },

    /** Answer a request if it is for a card. Returns whether it was. */
    handle(req, res) {
      const match = /^\/card\/([0-9a-f]{32})$/.exec((req.url || '').split('?')[0]);
      if (!match) return false;
      const html = cards.get(match[1]);
      if (html === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('This card is no longer available.');
        return true;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CARD_CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      res.end(html);
      return true;
    },
  };
}
