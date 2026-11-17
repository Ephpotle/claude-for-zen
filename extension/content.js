// Claude for Zen — content script (top frame only).
//
// Does the in-page work for the background page: outlining the page, finding
// elements, clicking, typing, scrolling, running JS, and capturing console
// output for tabs Claude is using.

(() => {
  if (window.__claudeForZenLoaded) return;
  window.__claudeForZenLoaded = true;

  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // ------------------------------------------------------------ element refs

  let refCounter = 0;
  const refOf = new WeakMap(); // element -> ref
  const elementOf = new Map(); // ref -> WeakRef(element)

  function getRef(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = 'e' + ++refCounter;
      refOf.set(el, ref);
      elementOf.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function fromRef(ref) {
    const el = elementOf.get(ref)?.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Element ${ref} is no longer on the page. Call read_page or find again for fresh refs.`);
    }
    return el;
  }

  const shadowOf = (el) => el.openOrClosedShadowRoot || el.shadowRoot || null;

  function elementAt(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let root = el && shadowOf(el); root; root = el && shadowOf(el)) {
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // ------------------------------------------------------- roles and naming

  const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'treeitem',
  ]);
  // Their accessible name already covers their contents; don't outline inside.
  const LEAF_ROLES = new Set(['link', 'button', 'heading', 'option', 'tab', 'menuitem', 'label', 'image']);

  const TAG_ROLES = {
    BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'image', NAV: 'navigation',
    MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form',
    UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    SUMMARY: 'button', LABEL: 'label', IFRAME: 'iframe', DIALOG: 'dialog', OPTION: 'option',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    SVG: 'image', VIDEO: 'video', AUDIO: 'audio',
  };
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
  };

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.tagName.toUpperCase();
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') return el.type === 'hidden' ? null : INPUT_ROLES[el.type] || 'textbox';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return TAG_ROLES[tag] || null;
  }

  function isInteractive(el, role, style) {
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    // Click handlers added from JS leave no trace except, usually, the cursor.
    if (style.cursor === 'pointer') {
      const parent = el.parentElement;
      return !parent || getComputedStyle(parent).cursor !== 'pointer';
    }
    return false;
  }

  function nameOf(el, role) {
    const label = el.getAttribute('aria-label');
    if (label) return squash(label);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (squash(text)) return squash(text);
    }
    const tag = el.tagName.toUpperCase();
    if (tag === 'IMG') return squash(el.alt || el.title);
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const labels = el.labels && [...el.labels].map((l) => l.textContent).join(' ');
      if (squash(labels)) return squash(labels);
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value) return squash(el.value);
      return squash(el.placeholder || el.title || el.name || '');
    }
    if (role === 'textbox') return squash(el.getAttribute('aria-placeholder') || el.title || '');
    return squash(el.textContent) || squash(el.title) || squash(el.querySelector?.('img[alt]')?.alt);
  }

  function isHidden(el, style) {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return true;
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR']);

  function describe(el, role, name) {
    let line = role || el.tagName.toLowerCase();
    if (name) line += ` "${clip(name, 100)}"`;
    line += ` [ref=${getRef(el)}]`;
    const tag = el.tagName.toUpperCase();
    if (role === 'heading' && /^H\d$/.test(tag)) line += ` level=${tag[1]}`;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (tag === 'INPUT' && !INPUT_ROLES[el.type] && el.type !== 'text') line += ` type=${el.type}`;
      if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' checked' : ' unchecked';
      else if (tag === 'SELECT') line += ` value="${clip(squash(el.selectedOptions[0]?.textContent), 60)}"`;
      else if (el.type !== 'password' && el.value) line += ` value="${clip(el.value, 80)}"`;
      if (el.disabled) line += ' disabled';
    } else if (tag === 'A' && el.hasAttribute('href')) {
      line += ` href="${clip(el.getAttribute('href'), 120)}"`;
    } else if (tag === 'BUTTON' && el.disabled) {
      line += ' disabled';
    }
    for (const attr of ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed']) {
      const v = el.getAttribute(attr);
      if (v !== null) line += ` ${attr.slice(5)}=${v}`;
    }
    return line;
  }

  /** Classify one element: null if it and its subtree should be skipped. */
  function inspect(el) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return null;
    const style = getComputedStyle(el);
    if (isHidden(el, style)) return null;
    const role = roleOf(el);
    return { role, interactive: isInteractive(el, role, style) };
  }

  // ----------------------------------------------------------- page outline

  function outline(root, { filter = 'interactive', maxChars = 40000 }) {
    const all = filter === 'all';
    const lines = [];
    let size = 0;
    let truncated = false;

    const emit = (depth, text) => {
      if (truncated) return;
      const line = '  '.repeat(depth) + '- ' + text;
      size += line.length + 1;
      if (size > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
    };

    const walk = (node, depth) => {
      if (truncated) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = squash(node.nodeValue);
        if (all && text) emit(depth, `text "${clip(text, 200)}"`);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const info = inspect(node);
      if (!info) return;
      const { role, interactive } = info;

      let shown = false;
      let leaf = false;
      if (interactive) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          emit(all ? depth : 0, describe(node, role, nameOf(node, role)));
          shown = true;
        }
      } else if (all && role) {
        if (LEAF_ROLES.has(role)) {
          const name = nameOf(node, role);
          if (name || role === 'image') {
            emit(depth, describe(node, role, name));
            shown = true;
          }
        } else {
          // Structural containers (list, navigation, ...) matter for their children.
          const name = squash(node.getAttribute('aria-label'));
          emit(depth, name ? `${role} "${clip(name, 100)}"` : role);
          shown = true;
        }
      }
      // A leaf's name already covers its contents.
      leaf = role && (LEAF_ROLES.has(role) || role === 'textbox' || role === 'combobox');
      if (leaf && shown) return;
      const next = shown && all ? depth + 1 : depth;
      const shadow = shadowOf(node);
      if (shadow) for (const child of shadow.childNodes) walk(child, next);
      for (const child of node.childNodes) walk(child, next);
    };

    walk(root, 0);
    let out = lines.join('\n');
    if (!out) out = filter === 'interactive' ? 'No interactive elements found. Try filter "all".' : 'The page appears to be empty.';
    if (truncated) out += `\n… output truncated at ${maxChars} characters. Pass ref to outline one section, or raise maxChars.`;
    return out;
  }

  // -------------------------------------------------------------- targeting

  function isInView(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  /** Resolve {ref|coordinate} to an element and a viewport point on it. */
  function target({ ref, coordinate }, { required = true } = {}) {
    if (ref) {
      const el = fromRef(ref);
      let rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (!isInView(rect) || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        rect = el.getBoundingClientRect();
      }
      return { el, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    if (coordinate) {
      const [x, y] = coordinate;
      const el = elementAt(x, y);
      if (!el) throw new Error(`Nothing at (${x}, ${y}); the viewport is ${innerWidth}x${innerHeight}.`);
      return { el, x, y };
    }
    if (required) throw new Error('Provide either ref or coordinate.');
    return null;
  }

  function label(el) {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = nameOf(el, role);
    return name ? `${role} "${clip(name, 60)}"` : role;
  }

  function parseModifiers(text) {
    const parts = (text || '').toLowerCase().split('+').map((p) => p.trim());
    return {
      ctrlKey: parts.includes('ctrl') || parts.includes('control'),
      shiftKey: parts.includes('shift'),
      altKey: parts.includes('alt'),
      metaKey: parts.includes('meta') || parts.includes('cmd') || parts.includes('win'),
    };
  }

  // ------------------------------------------------------------------ mouse

  function mouse(el, type, x, y, extra = {}) {
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x + (window.mozInnerScreenX || 0), screenY: y + (window.mozInnerScreenY || 0),
      ...extra,
    };
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    if (Ctor === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    return el.dispatchEvent(new Ctor(type, init));
  }

  function focusable(el) {
    for (let node = el; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
      if (node.matches('input, textarea, select, button, a[href], [tabindex], [contenteditable=""], [contenteditable="true"]')) {
        return node;
      }
    }
    return null;
  }

  function moveOver(el, x, y) {
    mouse(el, 'pointerover', x, y);
    mouse(el, 'pointerenter', x, y, { bubbles: false });
    mouse(el, 'mouseover', x, y);
    mouse(el, 'mouseenter', x, y, { bubbles: false });
    mouse(el, 'pointermove', x, y);
    mouse(el, 'mousemove', x, y);
  }

  function click(params) {
    const { el, x, y } = target(params);
    const buttonIndex = { left: 0, middle: 1, right: 2 }[params.button || 'left'];
    const mods = parseModifiers(params.modifiers);
    const count = params.count || 1;
    moveOver(el, x, y);
    for (let i = 1; i <= count; i++) {
      const down = { button: buttonIndex, buttons: 1 << (buttonIndex === 1 ? 2 : buttonIndex === 2 ? 1 : 0), detail: i, ...mods };
      const up = { ...down, buttons: 0 };
      mouse(el, 'pointerdown', x, y, down);
      if (mouse(el, 'mousedown', x, y, down)) {
        const f = focusable(el);
        if (f) f.focus({ preventScroll: true });
        else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      }
      mouse(el, 'pointerup', x, y, up);
      mouse(el, 'mouseup', x, y, up);
      if (buttonIndex === 0) mouse(el, 'click', x, y, up);
      else if (buttonIndex === 2) mouse(el, 'contextmenu', x, y, up);
      else mouse(el, 'auxclick', x, y, up);
    }
    if (count === 2 && buttonIndex === 0) mouse(el, 'dblclick', x, y, { button: 0, detail: 2, ...mods });
    let note = '';
    if (el.tagName === 'SELECT') note = ' Native dropdowns do not open for scripted clicks; use form_input to choose an option.';
    return `Clicked ${label(el)} at (${Math.round(x)}, ${Math.round(y)}).${note}`;
  }

  function hover(params) {
    const { el, x, y } = target(params);
    moveOver(el, x, y);
    return `Hovering ${label(el)} at (${Math.round(x)}, ${Math.round(y)}).`;
  }

  // --------------------------------------------------------------- keyboard

  const isTextField = (el) =>
    el && (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(el.type)));

  function fireInput(el, inputType, data) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data }));
  }

  // Assigning through the content script's view of the element calls the
  // native setter, which is what makes React/Vue-controlled inputs notice.
  function insertText(el, text) {
    if (isTextField(el)) {
      if (el.disabled || el.readOnly) throw new Error(`${label(el)} is read-only or disabled.`);
      try {
        const start = el.selectionStart;
        if (start === null) throw new Error('no selection');
        el.setRangeText(text, start, el.selectionEnd, 'end');
      } catch {
        el.value = el.value + text; // email/number inputs have no selection API
      }
      fireInput(el, 'insertText', text);
      return;
    }
    if (el && el.isContentEditable) {
      document.execCommand('insertText', false, text);
      return;
    }
    throw new Error('Nothing editable is focused. Pass a ref for the field to type into, or click it first.');
  }

  function deleteText(el, forward) {
    if (isTextField(el)) {
      try {
        let start = el.selectionStart;
        let end = el.selectionEnd;
        if (start === end) forward ? end++ : (start = Math.max(0, start - 1));
        el.setRangeText('', start, end, 'end');
      } catch {
        el.value = forward ? el.value : el.value.slice(0, -1);
      }
      fireInput(el, forward ? 'deleteContentForward' : 'deleteContentBackward', null);
    } else if (el && el.isContentEditable) {
      document.execCommand(forward ? 'forwardDelete' : 'delete');
    }
  }

  const KEY_ALIASES = {
    enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: ' ', spacebar: ' ',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown',
    left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown',
    home: 'Home', end: 'End', insert: 'Insert',
  };
  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, ' ': 32, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40,
    ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Insert: 45,
  };

  function tabbables() {
    return [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
    );
  }

  function pressKey(combo, el) {
    const parts = combo.split('+').map((p) => p.trim());
    // "+" itself, or a chord ending in "+", leaves an empty last part.
    let key = parts.pop() || '+';
    const mods = parseModifiers(parts.join('+'));
    key = KEY_ALIASES[key.toLowerCase()] || (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
    const printable = key.length === 1;
    const keyCode = KEY_CODES[key] || (printable ? key.toUpperCase().charCodeAt(0) : 0);
    const code = printable
      ? /[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : ''
      : key;
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, view: window, ...mods };

    el = el || document.activeElement || document.body;
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
    const chord = mods.ctrlKey || mods.metaKey || mods.altKey;
    if (proceed) {
      let typed = true;
      if (printable || key === 'Enter') {
        typed = el.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: printable ? key.charCodeAt(0) : 13 }));
      }
      if (typed) defaultKeyAction(el, key, mods, chord, printable);
    }
    // The default action may have moved focus or replaced the element.
    (el.isConnected ? el : document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keyup', init));
    return `Pressed ${combo}.`;
  }

  // Scripted key events are not "trusted", so the browser skips its built-in
  // behaviour for them. Reproduce the behaviours that matter.
  function defaultKeyAction(el, key, mods, chord, printable) {
    const editable = isTextField(el) || el.isContentEditable;
    if (chord) {
      if ((mods.ctrlKey || mods.metaKey) && key.toLowerCase() === 'a') {
        if (isTextField(el)) el.select();
        else document.execCommand('selectAll');
      }
      return;
    }
    if (key === 'Enter') {
      if (el.tagName === 'TEXTAREA') insertText(el, '\n');
      else if (el.isContentEditable) document.execCommand('insertParagraph');
      else if (el.tagName === 'INPUT' && isTextField(el)) {
        if (el.form) el.form.requestSubmit();
      } else if (el !== document.body) el.click();
    } else if (key === ' ' && !editable && el.matches('button, [role=button], input[type=checkbox], input[type=radio], summary')) {
      el.click();
    } else if (printable && editable) {
      insertText(el, key);
    } else if (key === 'Backspace' || key === 'Delete') {
      if (editable) deleteText(el, key === 'Delete');
    } else if (key === 'Tab') {
      const list = tabbables();
      const i = list.indexOf(el);
      const next = list[(i + (mods.shiftKey ? -1 : 1) + list.length) % list.length];
      if (next) next.focus();
    } else if (!editable) {
      const page = innerHeight * 0.9;
      const scroll = { ArrowDown: [0, 60], ArrowUp: [0, -60], PageDown: [0, page], PageUp: [0, -page], ' ': [0, page] }[key];
      if (scroll) window.scrollBy({ left: scroll[0], top: scroll[1], behavior: 'instant' });
      else if (key === 'Home') window.scrollTo({ top: 0, behavior: 'instant' });
      else if (key === 'End') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    }
  }

  function focusRef(ref) {
    if (!ref) return document.activeElement;
    const { el } = target({ ref });
    const f = focusable(el) || el;
    f.focus({ preventScroll: true });
    return f;
  }

  function type({ text, ref, submit }) {
    const el = focusRef(ref);
    insertText(el, text);
    if (submit) pressKey('Enter', el);
    return `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${label(el)}${submit ? ' and pressed Enter' : ''}.`;
  }

  function formInput({ ref, value }) {
    const el = fromRef(ref);
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const tag = el.tagName;
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = value === true || value === 'true' || value === 1 || value === 'on';
      if (el.checked !== want) el.click();
      return `${label(el)} is now ${el.checked ? 'checked' : 'unchecked'}.`;
    }
    if (tag === 'INPUT' && el.type === 'file') {
      throw new Error('File inputs cannot be set by an extension in Zen/Firefox; ask the user to choose the file.');
    }
    if (tag === 'SELECT') {
      const wanted = String(value);
      const options = [...el.options];
      const option =
        options.find((o) => o.value === wanted) ||
        options.find((o) => squash(o.textContent) === squash(wanted)) ||
        options.find((o) => squash(o.textContent).toLowerCase().includes(wanted.toLowerCase()));
      if (!option) {
        throw new Error(`No option "${wanted}". Options: ${options.map((o) => squash(o.textContent)).slice(0, 40).join(' | ')}`);
      }
      el.value = option.value;
      fireInput(el, 'insertReplacementText', null);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Selected "${squash(option.textContent)}" in ${label(el)}.`;
    }
    if (isTextField(el)) {
      if (el.disabled || el.readOnly) throw new Error(`${label(el)} is read-only or disabled.`);
      el.focus({ preventScroll: true });
      el.value = String(value);
      fireInput(el, 'insertReplacementText', String(value));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return `Set ${label(el)} to "${clip(String(value), 80)}".`;
    }
    if (el.isContentEditable) {
      el.focus({ preventScroll: true });
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(value));
      return `Set ${label(el)} text.`;
    }
    throw new Error(`${label(el)} is not a form control. Use click instead.`);
  }

  // ----------------------------------------------------------------- scroll

  function scroller(el) {
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      const y = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const x = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (x || y) return node;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scroll(params) {
    const { direction, amount = 600 } = params;
    if (!direction) {
      if (!params.ref) throw new Error('Provide a direction, or a ref to scroll into view.');
      const el = fromRef(params.ref);
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return `Scrolled ${label(el)} into view.`;
    }
    const hit = target(params, { required: false });
    const box = hit ? scroller(hit.el) : document.scrollingElement || document.documentElement;
    const [dx, dy] = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[direction];
    const before = [box.scrollLeft, box.scrollTop];
    box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    const moved = box.scrollLeft !== before[0] || box.scrollTop !== before[1];
    const where = `now at ${Math.round(box.scrollTop)} of ${Math.max(0, box.scrollHeight - box.clientHeight)}px vertically`;
    return moved ? `Scrolled ${direction} ${amount}px; ${where}.` : `Could not scroll ${direction} any further; ${where}.`;
  }

  // ------------------------------------------------------------ find / text

  function find({ query }) {
    const q = squash(query);
    const hits = [];
    const seen = new Set();
    const add = (el) => {
      if (seen.has(el) || hits.length >= 25) return;
      const info = inspect(el);
      if (!info || !el.getClientRects().length) return;
      seen.add(el);
      hits.push('- ' + describe(el, info.role, nameOf(el, info.role)));
    };

    if (/[#.\[\]>=:*]/.test(q) || /^[a-z][a-z0-9-]*$/.test(q)) {
      try {
        document.querySelectorAll(q).forEach(add);
      } catch {
        // not a selector after all
      }
    }

    const words = q.toLowerCase().split(' ').filter(Boolean);
    const matches = (text) => words.every((w) => text.includes(w));
    const everything = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll('*')) {
        everything.push(el);
        const shadow = shadowOf(el);
        if (shadow) collect(shadow);
      }
    };
    collect(document);

    // First pass: things with a role or that can be clicked. Second: any element
    // whose own text matches, so plain text on the page can still be located.
    for (const el of everything) {
      if (hits.length >= 25) break;
      if (SKIP_TAGS.has(el.tagName.toUpperCase())) continue;
      const role = roleOf(el);
      if (!role && !el.hasAttribute('onclick') && !el.hasAttribute('tabindex')) continue;
      const haystack = [role, nameOf(el, role), el.getAttribute('placeholder'), el.id, el.getAttribute('name'), el.getAttribute('title')]
        .filter(Boolean).join(' ').toLowerCase();
      if (matches(haystack)) add(el);
    }
    if (hits.length < 25) {
      for (const el of everything) {
        if (hits.length >= 25) break;
        if (SKIP_TAGS.has(el.tagName.toUpperCase())) continue;
        const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' ');
        if (squash(own) && matches(squash(own).toLowerCase())) add(el);
      }
    }
    if (!hits.length) return `Nothing on the page matches "${query}". Try fewer or different words, a CSS selector, or read_page.`;
    return hits.join('\n') + (hits.length >= 25 ? '\n… more matches not shown; narrow the query.' : '');
  }

  function pageText({ maxChars = 60000 }) {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    let text = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 200 && root !== document.body) text = (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    const cut = text.length > maxChars;
    return `${document.title}\n${location.href}\n\n${cut ? text.slice(0, maxChars) : text}${
      cut ? `\n… truncated (${text.length} characters in total; raise maxChars for more)` : ''
    }`;
  }

  // ------------------------------------------------------------- javascript

  // Runs inside the page, so it must be self-contained.
  function serializeInPage(value) {
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return String(value).slice(0, 1000);
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
    if (value instanceof Element) return value.outerHTML.slice(0, 3000);
    if (value instanceof Error) return String(value.stack || value);
    const seen = new WeakSet();
    try {
      const json = JSON.stringify(
        value,
        (key, v) => {
          if (typeof v === 'bigint') return String(v);
          if (typeof v === 'function') return '[function]';
          if (v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
          if (v instanceof Map) return { Map: [...v.entries()] };
          if (v instanceof Set) return { Set: [...v] };
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
          }
          return v;
        },
        2,
      );
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }

  function javascript({ code }) {
    const channel = '__claudeForZen_' + Math.random().toString(36).slice(2);
    const program = `(async () => {
      const send = (payload) => document.dispatchEvent(new CustomEvent(${JSON.stringify(channel)}, { detail: JSON.stringify(payload) }));
      try {
        const value = await (0, eval)(${JSON.stringify(code)});
        send({ ok: true, value: (${serializeInPage.toString()})(value) });
      } catch (err) {
        send({ ok: false, error: String(err) + (err && err.stack ? ' | at ' + String(err.stack).trim().split(/\s+/).slice(0, 3).join(' < ') : '') });
      }
    })()`;

    return new Promise((resolve, reject) => {
      const onResult = (event) => {
        document.removeEventListener(channel, onResult);
        const payload = JSON.parse(event.detail);
        if (payload.ok) resolve({ value: clip(payload.value, 50000) });
        else reject(new Error(payload.error));
      };
      document.addEventListener(channel, onResult);
      try {
        window.eval(program); // evaluates in the page's own JS world
      } catch (err) {
        document.removeEventListener(channel, onResult);
        if (err && (err.name === 'EvalError' || /Content.Security.Policy|unsafe-eval/i.test(String(err.message)))) {
          resolve({ blockedByCsp: true });
        } else {
          reject(new Error(String((err && err.message) || err)));
        }
      }
    });
  }

  // ---------------------------------------------------------------- console

  // Off until Claude uses this tab: wrapping console.* makes the page's own
  // log lines point at this script in DevTools, so don't do it to every tab.
  const CAPTURE_FLAG = '__claudeForZenCapture';
  let capturing = false;
  let queue = [];
  let flushTimer = null;

  function flushConsole() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!queue.length) return Promise.resolve();
    const entries = queue;
    queue = [];
    return browser.runtime.sendMessage({ type: 'console', entries }).catch(() => {});
  }

  function recordConsole(level, text) {
    queue.push({ level, text: clip(String(text), 3000), time: Date.now() });
    if (queue.length > 500) queue.shift();
    if (capturing && !flushTimer) flushTimer = setTimeout(flushConsole, 150);
  }

  function formatArg(arg) {
    if (arg === null || typeof arg !== 'object') return String(arg);
    try {
      if (arg instanceof window.Error || (arg.stack && arg.message)) return String(arg.stack || arg.message);
      return JSON.stringify(arg) ?? String(arg);
    } catch {
      return Object.prototype.toString.call(arg);
    }
  }

  function captureConsole() {
    if (capturing) return;
    capturing = true;
    try {
      sessionStorage.setItem(CAPTURE_FLAG, '1'); // lets a reload capture from the very first line
    } catch {}
    const pageConsole = window.wrappedJSObject?.console;    if (pageConsole) {
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = pageConsole[level];
        if (typeof original !== 'function') continue;
        const wrapped = function (...args) {
          try {
            recordConsole(level, args.map(formatArg).join(' '));
          } catch {}
          return Reflect.apply(original, pageConsole, args);
        };
        try {
          exportFunction(wrapped, pageConsole, { defineAs: level });
        } catch {}
      }
    }
    if (queue.length) flushConsole();
  }

  // Uncaught errors are cheap to listen for, so they are buffered from the
  // start and only sent if this tab turns out to be one Claude is using.
  window.addEventListener('error', (event) => {
    if (event.message) recordConsole('exception', `${event.message} (${event.filename || 'unknown'}:${event.lineno}:${event.colno})`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    let reason;
    try {
      reason = formatArg(event.reason);
    } catch {
      reason = 'unknown reason';
    }
    recordConsole('exception', `Unhandled promise rejection: ${reason}`);
  });

  let flagged = false;
  try {
    flagged = sessionStorage.getItem(CAPTURE_FLAG) === '1';
  } catch {}
  if (flagged) captureConsole();
  browser.runtime
    .sendMessage({ type: 'hello' })
    .then((reply) => {
      if (reply?.claimed) captureConsole();
      else if (flagged) {
        // Left over from an earlier session: stop forwarding this tab's console.
        capturing = false;
        queue = [];
        try {
          sessionStorage.removeItem(CAPTURE_FLAG);
        } catch {}
      }
    })
    .catch(() => {});

  // --------------------------------------------------------------- dispatch

  const actions = {
    read_page: (p) => outline(p.ref ? fromRef(p.ref) : document.body || document.documentElement, p),
    get_page_text: pageText,
    find,
    click,
    hover,
    type,
    key: (p) => pressKey(p.key, p.ref ? focusRef(p.ref) : null),
    form_input: formInput,
    scroll,
    has: ({ text, selector }) =>
      selector ? !!document.querySelector(selector) : (document.body?.innerText || '').includes(text),
    javascript,
    viewport: () => ({ width: innerWidth, height: innerHeight }),
    captureConsole,
    flushConsole,
  };

  // overlay.js (marks, cards, explain, comments) adds its actions to this
  // table and reuses the element helpers.
  globalThis.__claudeForZenCore = { actions, fromRef, getRef, label, isInView, elementAt, squash, clip };

  browser.runtime.onMessage.addListener((message) => {
    const action = actions[message.action];
    if (!action) return undefined;
    return (async () => {
      try {
        const result = await action(message.params || {});
        return { result: result === undefined ? 'ok' : result, capturing };
      } catch (err) {
        return { error: String((err && err.message) || err), capturing };
      }
    })();
  });
})();
