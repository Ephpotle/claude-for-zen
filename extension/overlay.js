// Claude for Zen — things drawn on top of the page (top frame only):
//   marks     outlines and labels Claude uses to point at parts of the page
//   cards     floating panels for explanations and generated visuals
//   explain   a button beside selected text that explains it in a card
//   comments  pin a note anywhere on the page and send it to Claude
//
// Everything lives in one closed shadow root so the page's styles and scripts
// cannot reach it, and it is removed with the page on navigation.

(() => {
  const core = globalThis.__claudeForZenCore;
  if (!core || core.overlay) return;
  core.overlay = true;
  const { actions, fromRef, getRef, label, isInView, elementAt, squash, clip } = core;
  const markdown = globalThis.claudeForZenMarkdown;

  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  // ------------------------------------------------------------------ layer

  let host = null;
  let layer = null;

  function getLayer() {
    if (host && host.isConnected) return layer;
    host = document.createElement('claude-for-zen-overlay');
    // Set through the CSSOM, which a page's Content-Security-Policy allows.
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = browser.runtime.getURL('overlay.css'); // extension files are exempt from page CSP
    layer = make('div', 'layer');
    layer.style.visibility = 'hidden'; // until the stylesheet is in, to avoid a flash of raw boxes
    sheet.addEventListener('load', () => (layer.style.visibility = ''));
    root.append(sheet, layer);
    document.documentElement.append(host);
    return layer;
  }

  const isOurs = (event) => !!host && event.composedPath().includes(host);

  // ------------------------------------------------------------------ marks

  const marks = []; // { rects(): DOMRect[], alive(): bool, isText, label, boxes: [], chip, dim }
  let ticking = false;

  function tick() {
    for (const mark of [...marks]) {
      if (!mark.alive()) removeMark(mark);
      else layoutMark(mark);
    }
    ticking = marks.length > 0;
    if (ticking) requestAnimationFrame(tick);
  }

  // Scrolling and resizing also re-place marks directly, for the same reason.
  const relayout = () => marks.forEach(layoutMark);
  document.addEventListener('scroll', relayout, { passive: true, capture: true });
  window.addEventListener('resize', relayout, { passive: true });

  function layoutMark(mark) {
    const rects = mark.rects();
    while (mark.boxes.length < rects.length) {
      const box = make('div', mark.isText ? 'box text' : 'box');
      if (!mark.isText) box.classList.add('arrive');
      if (mark.dim && mark.boxes.length === 0) box.classList.add('dim');
      getLayer().prepend(box);
      mark.boxes.push(box);
    }
    while (mark.boxes.length > rects.length) mark.boxes.pop().remove();
    const pad = mark.isText ? 1 : 4;
    rects.forEach((r, i) => {
      const s = mark.boxes[i].style;
      s.left = r.left - pad + 'px';
      s.top = r.top - pad + 'px';
      s.width = r.width + pad * 2 + 'px';
      s.height = r.height + pad * 2 + 'px';
    });
    if (!mark.chip) return;
    const first = rects[0];
    if (!first) {
      mark.chip.style.display = 'none';
      return;
    }
    mark.chip.style.display = '';
    const height = mark.chip.offsetHeight || 24;
    const above = first.top - height - 9;
    const top = above >= 4 ? above : Math.min(first.bottom + 9, innerHeight - height - 4);
    mark.chip.style.top = Math.max(4, top) + 'px';
    mark.chip.style.left = Math.max(4, Math.min(first.left - 4, innerWidth - mark.chip.offsetWidth - 4)) + 'px';
  }

  function addMark({ el, range, text, dim }) {
    const mark = {
      isText: !!range,
      dim: !!dim,
      boxes: [],
      chip: null,
      alive: () => (el ? el.isConnected : range.startContainer.isConnected),
      rects: () => {
        if (el) {
          const r = el.getBoundingClientRect();
          return r.width || r.height ? [r] : [];
        }
        return [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      },
    };
    if (text) {
      mark.chip = make('div', 'chip');
      mark.chip.append(make('span', '', clip(text, 140)));
      const dismiss = make('button', '', '×');
      dismiss.title = 'Remove this mark';
      dismiss.addEventListener('click', () => removeMark(mark));
      mark.chip.append(dismiss);
      getLayer().append(mark.chip);
    }
    marks.push(mark);
    layoutMark(mark); // now, not on the next frame: frames stall in windows that are covered
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(tick);
    }
    return mark;
  }

  function removeMark(mark) {
    const i = marks.indexOf(mark);
    if (i >= 0) marks.splice(i, 1);
    mark.boxes.forEach((box) => box.remove());
    mark.chip?.remove();
  }

  function clearMarks() {
    const count = marks.length;
    [...marks].forEach(removeMark);
    return count;
  }

  // Find a passage of text on the page, ignoring differences in whitespace and
  // letter case, even when it runs across several elements.
  function findText(needle) {
    needle = squash(needle).toLowerCase();
    if (!needle || !document.body) return null;
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
    const inline = new Map();
    const isInline = (el) => {
      if (!inline.has(el)) inline.set(el, getComputedStyle(el).display.startsWith('inline'));
      return inline.get(el);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let hay = '';
    const where = []; // for each character of hay: [text node, offset]
    let lastSpace = true;
    let previousParent = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || skip.has(parent.tagName)) continue;
      // Text in separate blocks is separated, even with no whitespace between them.
      if (parent !== previousParent && !lastSpace && !isInline(parent)) {
        hay += ' ';
        where.push([node, 0]);
        lastSpace = true;
      }
      previousParent = parent;
      const value = node.nodeValue;
      for (let j = 0; j < value.length; j++) {
        const c = value[j];
        if (/\s/.test(c)) {
          if (lastSpace) continue;
          hay += ' ';
          lastSpace = true;
        } else {
          const lower = c.toLowerCase();
          hay += lower.length === 1 ? lower : c;
          lastSpace = false;
        }
        where.push([node, j]);
      }
    }
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const [startNode, startOffset] = where[at];
      const [endNode, endOffset] = where[at + needle.length - 1];
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset + 1);
      if ([...range.getClientRects()].some((r) => r.width > 1 && r.height > 1)) return range; // skip hidden copies
    }
    return null;
  }

  actions.annotate = ({ marks: specs = [], dim, keep }) => {
    if (!keep) clearMarks();
    const done = [];
    const missed = [];
    let first = null;
    for (const spec of specs) {
      let mark = null;
      if (spec.ref) {
        const el = fromRef(spec.ref);
        mark = addMark({ el, text: spec.label, dim: dim && !first });
        done.push(label(el));
        first = first || el;
      } else if (spec.text) {
        const range = findText(spec.text) || (spec.text.length > 80 ? findText(spec.text.slice(0, 60)) : null);
        if (!range) {
          missed.push(clip(squash(spec.text), 60));
          continue;
        }
        mark = addMark({ range, text: spec.label, dim: dim && !first });
        done.push(`text "${clip(squash(spec.text), 50)}"`);
        first = first || range;
      }
    }
    if (first && !isInView(first.getBoundingClientRect())) {
      const el = first.nodeType === Node.ELEMENT_NODE ? first : first.startContainer.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    let out = done.length ? `Marked on the page: ${done.join('; ')}.` : 'Nothing was marked.';
    if (missed.length) out += ` Could not find this text on the page: ${missed.map((m) => `"${m}"`).join(', ')}. Quote it exactly as it appears, or use a ref.`;
    if (done.length) out += ' Marks stay until the page reloads, the user dismisses them, or you call clear_annotations.';
    return out;
  };

  actions.clear_annotations = () => {
    const count = clearMarks();
    return count ? `Removed ${count} mark${count === 1 ? '' : 's'}.` : 'There were no marks on the page.';
  };

  // ------------------------------------------------------------------ cards

  const cards = [];

  /** A floating panel. anchor: a rect to sit beside, or null for the bottom-right corner. */
  function createCard({ title, anchor, width = 360, className = '' }) {
    const el = make('section', `card ${className}`);
    el.style.width = width + 'px';
    const header = make('header');
    const heading = make('strong', '', title);
    const close = make('button', '', '×');
    close.title = 'Close';
    header.append(heading, close);
    const body = make('div', 'body');
    el.append(header, body);
    getLayer().append(el);

    const s = el.style;
    if (anchor) {
      s.left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8)) + 'px';
      const below = innerHeight - anchor.bottom - 18;
      if (below >= 230 || below >= anchor.top - 18) {
        s.top = Math.max(8, anchor.bottom + 10) + 'px';
        s.maxHeight = Math.max(160, below) + 'px';
      } else {
        s.bottom = innerHeight - anchor.top + 10 + 'px';
        s.maxHeight = Math.max(160, anchor.top - 18) + 'px';
      }
    } else {
      s.right = '16px';
      s.bottom = 16 + cards.length * 14 + 'px';
    }

    const card = {
      el,
      body,
      onClose: null,
      setTitle: (text) => (heading.textContent = text),
      close() {
        const i = cards.indexOf(card);
        if (i < 0) return;
        cards.splice(i, 1);
        el.remove();
        card.onClose?.();
      },
    };
    close.addEventListener('click', () => card.close());

    // Drag by the header.
    header.addEventListener('pointerdown', (down) => {
      if (down.target === close) return;
      const box = el.getBoundingClientRect();
      const dx = down.clientX - box.left;
      const dy = down.clientY - box.top;
      s.right = s.bottom = '';
      s.left = box.left + 'px';
      s.top = box.top + 'px';
      s.maxHeight = '';
      header.setPointerCapture(down.pointerId);
      const move = (e) => {
        s.left = Math.max(0, Math.min(e.clientX - dx, innerWidth - 60)) + 'px';
        s.top = Math.max(0, Math.min(e.clientY - dy, innerHeight - 30)) + 'px';
      };
      const up = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', up);
      };
      header.addEventListener('pointermove', move);
      header.addEventListener('pointerup', up);
    });

    cards.push(card);
    return card;
  }

  // Generated HTML is drawn by an extension page (exempt from the site's CSP)
  // in a sandboxed frame: opaque origin, no add-on powers, no network. The HTML
  // is posted to it, with a one-off token so the host page cannot feed it
  // anything. `drawn` resolves with the frame's report of how it went.
  function visualFrame(html, height) {
    const frame = make('iframe');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = browser.runtime.getURL('card.html') + '#' + token;
    frame.style.height = height + 'px';
    frame.drawn = new Promise((resolve) => {
      const timer = setTimeout(() => finish({ ok: false, error: 'the card frame did not load (the page or another add-on may be blocking it)' }), 6000);
      const finish = (result) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(result);
      };
      let sent = false;
      const onMessage = (event) => {
        // The frame only announces that it is listening. The host page can see
        // that announcement, so it carries no secret; the token and the HTML go
        // to the frame alone, and its answer comes back over a private port.
        if (sent || event.source !== frame.contentWindow || !event.data || event.data.claudeForZenCard !== 'ready') return;
        sent = true;
        const channel = new MessageChannel();
        channel.port1.onmessage = (reply) => {
          channel.port1.close();
          const result = reply.data && typeof reply.data === 'object' ? reply.data : { ok: false, error: 'the card frame gave no result' };
          finish(result);
        };
        frame.contentWindow.postMessage({ claudeForZenCard: token, html: String(html) }, '*', [channel.port2]);
      };
      window.addEventListener('message', onMessage);
    });
    return frame;
  }

  /** Close the cards Claude put on the page (not an Explain card the user opened). */
  const closeClaudeCards = () => {
    const mine = cards.filter((card) => card.fromClaude);
    mine.forEach((card) => card.close());
    return mine.length;
  };
  actions.close_cards = () => {
    const n = closeClaudeCards();
    return n ? `Closed ${n} card${n === 1 ? '' : 's'}.` : 'There were no cards from Claude on the page.';
  };

  actions.show_card = async ({ html, title = 'From Claude', ref, width = 400, height = 300, keep = false }) => {
    if (typeof html !== 'string' || !html.trim()) throw new Error('The card has no content.');
    const replaced = keep ? 0 : closeClaudeCards();
    width = Math.max(220, Math.min(width, innerWidth - 16));
    height = Math.max(120, Math.min(height, innerHeight - 70));
    let anchor = null;
    if (ref) {
      const el = fromRef(ref);
      if (!isInView(el.getBoundingClientRect())) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      anchor = el.getBoundingClientRect();
    }
    const card = createCard({ title, anchor, width });
    card.fromClaude = true;
    card.body.style.overflow = 'hidden';
    const frame = visualFrame(html, height);
    card.body.append(frame);
    const result = await frame.drawn;
    if (!result.ok) {
      card.close();
      throw new Error(`The card could not be drawn: ${result.error}. Nothing was left on the page.`);
    }
    const notes = [];
    if (replaced) notes.push(`It replaced ${replaced} earlier card${replaced === 1 ? '' : 's'}.`);
    if (result.empty) notes.push('Warning: the card drew, but its body looks empty (no text, drawing or controls).');
    if (result.errors && result.errors.length) notes.push(`Warning: its script reported: ${result.errors.join('; ')}`);
    if (result.contentHeight > height + 24) notes.push(`Its content is ${result.contentHeight}px tall, so part of it is cut off at ${height}px.`);
    return [`Showing a ${width}x${height} card titled "${title}" on the page, and it drew its content. The user can drag or close it.`, ...notes].join(' ');
  };

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      if (picking) stopPicking();
      else if (cards.length) cards[cards.length - 1].close();
      else return;
      event.stopPropagation();
    },
    true,
  );

  // -------------------------------------------------------------- selection

  function selectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const range = selection.getRangeAt(0);
    // Context: the nearest enclosing block with a reasonable amount of text.
    let block = range.commonAncestorContainer;
    if (block.nodeType !== Node.ELEMENT_NODE) block = block.parentElement;
    while (block && block !== document.body && (block.innerText || '').length < Math.max(300, text.length + 120)) {
      block = block.parentElement;
    }
    let context = squash((block || document.body).innerText || '');
    if (context.length > 2500) {
      const at = Math.max(0, context.indexOf(squash(text).slice(0, 40)));
      const start = Math.max(0, at - 900);
      context = (start ? '…' : '') + context.slice(start, start + 2500) + '…';
    }
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    return { text, context, rect: range.getBoundingClientRect(), lastRect: rects[rects.length - 1] || range.getBoundingClientRect() };
  }

  actions.get_selection = () => {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      try {
        const picked = active.value.slice(active.selectionStart, active.selectionEnd);
        if (picked) return `Selected text (inside ${label(active)}):\n${clip(picked, 20000)}`;
      } catch {}
    }
    const info = selectionInfo();
    if (!info) return 'Nothing is selected on the page.';
    return `Selected text:\n${clip(info.text, 20000)}\n\nSurrounding text:\n${info.context}`;
  };

  // ---------------------------------------------------------------- explain

  let explainEnabled = true;
  let explainButton = null;
  browser.storage.local.get({ explainButton: true }).then((saved) => (explainEnabled = saved.explainButton));
  browser.storage.onChanged.addListener((changes) => {
    if (!changes.explainButton) return;
    explainEnabled = changes.explainButton.newValue;
    if (!explainEnabled) hideExplainButton();
  });

  function hideExplainButton() {
    explainButton?.remove();
    explainButton = null;
  }

  function offerExplain() {
    hideExplainButton();
    if (!explainEnabled || picking) return;
    const info = selectionInfo();
    if (!info || info.text.length < 2 || info.text.length > 6000) return;
    const node = window.getSelection().anchorNode;
    const parent = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (parent && parent.isContentEditable) return; // don't get in the way of editing
    explainButton = make('button', 'explain', 'Explain');
    explainButton.style.left = Math.max(4, Math.min(info.lastRect.right + 6, innerWidth - 84)) + 'px';
    explainButton.style.top = Math.max(4, Math.min(info.lastRect.bottom + 6, innerHeight - 34)) + 'px';
    explainButton.addEventListener('mousedown', (event) => event.preventDefault()); // keep the selection
    explainButton.addEventListener('click', () => explain());
    getLayer().append(explainButton);
  }

  document.addEventListener('mouseup', (event) => !isOurs(event) && setTimeout(offerExplain, 10));
  document.addEventListener('keyup', (event) => event.shiftKey && setTimeout(offerExplain, 10));
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hideExplainButton();
  });
  document.addEventListener('scroll', hideExplainButton, { passive: true, capture: true });

  function explain() {
    const info = selectionInfo();
    hideExplainButton();
    if (!info) return 'Nothing is selected on the page.';
    const card = createCard({ title: 'Explain', anchor: info.rect, width: 370 });
    card.body.append(make('div', 'quote', clip(squash(info.text), 220)));
    const answer = make('div', 'answer waiting', 'Thinking…');
    const visual = make('div');
    card.body.append(answer, visual);
    const footer = make('footer');
    const buttons = [
      ['Simpler', 'simpler'],
      ['More detail', 'detail'],
      ['Show it visually', 'visual'],
    ].map(([text, mode]) => {
      const button = make('button', '', text);
      button.disabled = true;
      button.addEventListener('click', () => request(mode));
      footer.append(button);
      return button;
    });
    card.el.append(footer);

    const port = browser.runtime.connect({ name: 'chat' });
    card.onClose = () => port.disconnect();
    let text = '';
    let drawing = null;
    const finish = () => buttons.forEach((b) => (b.disabled = false));

    function request(mode) {
      buttons.forEach((b) => (b.disabled = true));
      if (mode === 'visual') {
        drawing?.remove();
        drawing = make('div', 'note', 'Drawing… this takes a little while.');
        visual.replaceChildren(drawing);
        visual.className = '';
      } else {
        text = '';
        answer.className = 'answer waiting';
        answer.textContent = 'Thinking…';
      }
      port.postMessage({ type: 'explain', mode, selection: info.text.slice(0, 6000), context: info.context, title: document.title, url: location.href });
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === 'delta') {
        text += msg.text;
        answer.className = 'answer';
        try {
          answer.innerHTML = markdown(text);
        } catch {
          answer.textContent = text;
        }
      } else if (msg.type === 'card') {
        visual.className = 'visual';
        visual.replaceChildren(visualFrame(msg.html, 300));
        card.body.scrollTop = card.body.scrollHeight;
        finish();
      } else if (msg.type === 'done') {
        finish();
      } else if (msg.type === 'error') {
        const target = drawing && drawing.isConnected ? drawing : answer;
        target.className = target === answer ? 'answer failed' : 'note';
        target.textContent = msg.text;
        finish();
      }
    });
    port.onDisconnect.addListener(() => finish());
    request('default');
    return 'Explaining the selection in a card on the page.';
  }
  actions.explain_selection = explain;

  // --------------------------------------------------------------- comments

  let picking = null; // { banner, hover, off() }
  let lastContext = null; // where the context menu was last opened

  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!isOurs(event)) lastContext = { el: event.target, x: event.clientX, y: event.clientY };
    },
    true,
  );

  function stopPicking() {
    if (!picking) return;
    picking.off();
    picking.banner.remove();
    picking.hover.remove();
    picking = null;
  }

  function startPicking() {
    if (picking) return 'Already waiting for a click.';
    hideExplainButton();
    const banner = make('div', 'banner');
    banner.append(make('span', '', 'Click the part of the page you want to comment on'));
    const cancel = make('button', '', 'Cancel');
    cancel.addEventListener('click', stopPicking);
    banner.append(cancel);
    const hover = make('div', 'hover');
    hover.style.display = 'none';
    getLayer().append(hover, banner);

    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';
    const swallow = (event) => {
      if (isOurs(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (event) => {
      if (isOurs(event)) return (hover.style.display = 'none');
      const el = elementAt(event.clientX, event.clientY);
      if (!el) return;
      const r = el.getBoundingClientRect();
      Object.assign(hover.style, { display: '', left: r.left - 3 + 'px', top: r.top - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px' });
    };
    const pick = (event) => {
      if (isOurs(event)) return;
      swallow(event);
      const el = elementAt(event.clientX, event.clientY);
      stopPicking();
      if (el) composeComment(el, event.clientX, event.clientY);
    };
    const events = [['mousemove', move], ['click', pick], ['mousedown', swallow], ['mouseup', swallow], ['pointerdown', swallow], ['pointerup', swallow]];
    events.forEach(([type, fn]) => document.addEventListener(type, fn, true));
    picking = {
      banner,
      hover,
      off() {
        events.forEach(([type, fn]) => document.removeEventListener(type, fn, true));
        document.documentElement.style.cursor = previousCursor;
      },
    };
    return 'Waiting for the user to click the part of the page they want to comment on.';
  }

  function composeComment(el, x, y) {
    const selected = selectionInfo();
    const mark = addMark({ el, text: 'Your comment' });
    const where = label(el);
    const card = createCard({ title: 'Comment for Claude', anchor: new DOMRect(x, y, 1, 1), width: 300, className: 'comment' });
    card.body.append(make('div', 'target', `On: ${where}`));
    const input = make('textarea');
    input.placeholder = 'What should Claude know or do about this?';
    const row = make('div', 'row');
    const status = make('span', '', 'Ctrl+Enter to send');
    const send = make('button', '', 'Send');
    send.disabled = true;
    row.append(status, send);
    card.body.append(input, row);
    setTimeout(() => input.focus(), 0);

    let sent = false;
    let port = null;
    card.onClose = () => {
      port?.disconnect();
      if (!sent) removeMark(mark);
    };
    input.addEventListener('input', () => (send.disabled = !input.value.trim()));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation(); // keep the page's own shortcuts out of it
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !send.disabled) submit();
      if (event.key === 'Escape') card.close();
    });
    send.addEventListener('click', submit);

    function submit() {
      const comment = input.value.trim();
      if (!comment) return;
      send.disabled = true;
      input.disabled = true;
      status.textContent = 'Sending…';
      const rect = el.getBoundingClientRect();
      port = browser.runtime.connect({ name: 'chat' });
      port.onMessage.addListener((msg) => {
        if (msg.type === 'comment_sent') {
          sent = true;
          mark.chip.firstChild.textContent = clip(comment, 140);
          status.textContent = 'Sent. Claude replies in the chat panel.';
          setTimeout(() => card.close(), 1600);
        } else if (msg.type === 'error') {
          status.textContent = msg.text;
          input.disabled = false;
          send.disabled = false;
        }
      });
      port.postMessage({
        type: 'comment',
        comment,
        title: document.title,
        url: location.href,
        target: {
          ref: getRef(el),
          description: where,
          text: clip(squash(el.innerText || el.value || el.alt || ''), 400),
          x: Math.round(x),
          y: Math.round(y),
          box: [rect.left, rect.top, rect.width, rect.height].map(Math.round),
        },
        selection: selected ? clip(selected.text, 2000) : '',
      });
    }
  }

  // The overlay sits in a closed shadow root, so page scripts cannot see or
  // drive it. These three let the end-to-end tests do so through the add-on.
  actions.overlay_state = () => ({
    marks: marks.map((m) => ({ text: m.chip ? m.chip.firstChild.textContent : '', boxes: m.boxes.length })),
    cards: cards.map((c) => ({
      title: c.el.querySelector('header strong').textContent,
      text: squash(c.body.innerText || c.body.textContent),
      frames: c.el.querySelectorAll('iframe').length,
      buttons: [...c.el.querySelectorAll('footer button, .row button')].map((b) => ({ text: b.textContent, disabled: b.disabled })),
    })),
    explainButton: !!explainButton,
    picking: !!picking,
  });
  actions.overlay_click = ({ text }) => {
    const button = [...getLayer().querySelectorAll('button')].reverse().find((b) => b.textContent.trim() === text && !b.disabled);
    if (!button) throw new Error(`No enabled overlay button "${text}".`);
    button.click();
    return `Clicked "${text}".`;
  };
  actions.overlay_type = ({ text }) => {
    const input = getLayer().querySelector('textarea');
    if (!input) throw new Error('No comment box is open.');
    input.value = text;
    input.dispatchEvent(new Event('input'));
    return 'Typed.';
  };

  actions.comment_mode = startPicking;
  actions.comment_here = () => {
    const at = lastContext && lastContext.el && lastContext.el.isConnected ? lastContext : null;
    if (!at) return startPicking();
    const el = at.el.nodeType === Node.ELEMENT_NODE ? at.el : at.el.parentElement;
    composeComment(el, at.x, at.y);
    return 'Comment box opened.';
  };

})();
