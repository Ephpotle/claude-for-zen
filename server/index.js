#!/usr/bin/env node
// Claude for Zen — MCP server.
//
// Claude Code launches this over stdio. It also listens on a localhost
// WebSocket port; the Zen/Firefox extension connects to that port and carries
// out the browser commands. stdout is reserved for MCP, so log to stderr only.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.js';

const bridge = new Bridge();
const server = new McpServer({ name: 'claude-for-zen', version: '0.1.0' });

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

/** Register a tool that forwards straight to the extension. */
function tool(name, description, shape, { method = name, timeout, format = text } = {}) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return format(await bridge.call(method, args, timeout), args);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  });
}

const tabId = z.number().int().describe('Tab ID, from tabs_list or tab_create');
const ref = z
  .string()
  .optional()
  .describe('Element reference from read_page or find, e.g. "e12"');
const coordinate = z
  .array(z.number())
  .length(2)
  .optional()
  .describe('[x, y] in viewport CSS pixels, as seen in a screenshot');

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// People keep hundreds of tabs open, so this is a compact, capped listing with
// the tab the user is looking at first, not a raw dump.
function formatTabs(tabs, { query, limit = 30 }) {
  const windows = new Set(tabs.map((t) => t.windowId)).size;
  const line = (t) => `[${t.tabId}] ${clip(t.title || '(untitled)', 80)} — ${clip(t.url, 160)}${windows > 1 ? ` (window ${t.windowId})` : ''}${t.asleep ? ' (unloaded; it loads again when you use it)' : ''}`;
  const current = tabs.find((t) => t.current);
  let rest = tabs.filter((t) => t !== current);
  if (query) {
    const q = query.toLowerCase();
    rest = rest.filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(q));
  }
  // Tabs showing in other windows first, then the remainder in tab-strip order.
  rest.sort((a, b) => Number(b.active) - Number(a.active));
  const shown = rest.slice(0, limit);
  const out = [];
  out.push(current ? `Current tab (the one the user is looking at):\n${line(current)}` : 'No tab is marked current.');
  if (shown.length) {
    out.push(
      `${query ? `Other tabs matching "${query}"` : 'Other tabs'} (${shown.length} of ${rest.length}):\n` +
        shown.map((t) => line(t) + (t.active ? ' (showing in another window)' : '')).join('\n'),
    );
  } else if (query) {
    out.push(`No other tabs match "${query}".`);
  }
  if (rest.length > shown.length) out.push('Pass query to search titles and URLs, or raise limit.');
  return text(out.join('\n\n'));
}

tool(
  'tabs_list',
  'List open tabs in Zen as "[tabId] title — url", with the tab the user is looking at first. Call this first. Shows up to `limit` other tabs; use `query` to search when there are many.',
  {
    query: z.string().optional().describe('Only tabs whose title or URL contains this text'),
    limit: z.number().int().optional().describe('How many other tabs to show, default 30'),
  },
  { format: formatTabs },
);

tool(
  'tab_create',
  'Open a new tab in Zen, optionally at a URL, and wait for it to load. It opens in the same container as the page the user is on, so it shares the same logins. Prefer working in a tab you created over reusing one of the user\'s tabs.',
  {
    url: z.string().optional().describe('URL to open; blank tab if omitted'),
    active: z.boolean().optional().describe('Bring the tab to the front (default true)'),
    windowId: z.number().int().optional().describe('Window to open it in (default: the window in front)'),
    plain: z.boolean().optional().describe('Open outside any container. By default the tab uses the same container (set of logins) as the page the user is on.'),
  },
  { timeout: 45_000 },
);

tool('tab_close', 'Close a tab.', { tabId });

// For the tests only: unload a tab the way Zen does to idle ones.
if (process.env.CLAUDE_FOR_ZEN_DEV_ONLY) tool('tab_discard', 'Unload a tab (test aid).', { tabId });

tool(
  'navigate',
  'Navigate a tab to a URL, or go "back", "forward" or "reload". Waits for the page to finish loading.',
  { tabId, url: z.string().describe('A URL, or one of: back, forward, reload') },
  { timeout: 45_000 },
);

tool(
  'read_page',
  'Get a structured outline of the page: elements with their role, name and a ref ID to use with click/type/form_input. filter "interactive" (default) lists only buttons, links and inputs; "all" also includes headings, text and images.',
  {
    tabId,
    filter: z.enum(['interactive', 'all']).optional(),
    ref: ref.describe('Only outline the subtree under this element'),
    maxChars: z.number().int().optional().describe('Output cap, default 40000'),
  },
);

tool('get_page_text', 'Get the readable text of the page (article/main content when present).', {
  tabId,
  maxChars: z.number().int().optional().describe('Output cap, default 60000'),
});

tool(
  'find',
  'Find elements whose text, label, placeholder, role or CSS selector matches a query. Returns refs. Plain text match, not natural language: use words that appear on the element ("Sign in", "search"), or a CSS selector.',
  { tabId, query: z.string() },
);

tool(
  'click',
  'Click an element by ref or by viewport coordinate.',
  {
    tabId,
    ref,
    coordinate,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).max(3).optional().describe('2 for double click'),
    modifiers: z.string().optional().describe('e.g. "ctrl", "shift", "ctrl+shift"'),
  },
);

tool('hover', 'Move the mouse over an element (by ref or coordinate) to reveal menus and tooltips.', {
  tabId,
  ref,
  coordinate,
});

tool(
  'type',
  'Type text into an element (by ref), or into whatever is focused. Inserts at the cursor; use form_input to replace a field\'s whole value.',
  {
    tabId,
    text: z.string(),
    ref,
    submit: z.boolean().optional().describe('Press Enter afterwards'),
  },
);

tool(
  'key',
  'Press a key or chord on the focused element, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Backspace", "ctrl+a".',
  { tabId, key: z.string(), ref },
);

tool(
  'form_input',
  'Set the value of a form control by ref: text fields (replaces the value), checkboxes/radios (true/false), and selects (option value or visible label).',
  { tabId, ref: z.string(), value: z.union([z.string(), z.boolean(), z.number()]) },
);

tool(
  'scroll',
  'Scroll the page or a scrollable area. With ref and no direction, scrolls that element into view.',
  {
    tabId,
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().optional().describe('Pixels, default 600'),
    ref,
    coordinate: coordinate.describe('Scroll the scrollable area under this point'),
  },
);

tool(
  'annotate',
  'Point things out on the page itself: draws an outline around elements (by ref) or highlights a passage (by quoting its text), each with an optional short label. Use this to show the user where something is instead of describing its position. Replaces earlier marks unless keep is true.',
  {
    tabId,
    marks: z
      .array(
        z.object({
          ref: z.string().optional().describe('Element to outline, from read_page or find'),
          text: z.string().optional().describe('Exact passage of page text to highlight (instead of ref)'),
          label: z.string().optional().describe('Short note shown beside the mark'),
        }),
      )
      .min(1),
    dim: z.boolean().optional().describe('Darken the rest of the page around the first mark'),
    keep: z.boolean().optional().describe('Keep existing marks instead of replacing them'),
  },
);

tool('clear_annotations', 'Remove all marks drawn on the page by annotate.', { tabId });

tool(
  'get_selection',
  'Get the text the user currently has selected on the page, with the surrounding passage for context.',
  { tabId },
);

server.registerTool(
  'show_card',
  {
    description:
      'Show a floating card on the page containing HTML you write: a diagram, an animation, a worked example, a small interactive demo. The HTML must be self-contained (inline <style>, <script>, SVG or canvas); it runs isolated with no network access, so no external scripts, fonts, images or fetch (data: images are fine). Design it for the given size without scrolling, and support light and dark with prefers-color-scheme. The user can drag and close the card. A new card replaces the ones you showed before unless keep is true. The result says whether the content actually drew; if it reports an error or an empty body, fix the HTML rather than telling the user it is there.',
    inputSchema: {
      tabId,
      html: z.string().describe('A complete HTML document, or body content'),
      title: z.string().optional().describe('Shown in the card header'),
      ref: ref.describe('Place the card beside this element; default is the bottom-right corner'),
      width: z.number().int().optional().describe('Pixels, default 400'),
      height: z.number().int().optional().describe('Pixels, default 300'),
      keep: z.boolean().optional().describe('Leave your earlier cards on the page (default: replace them)'),
    },
  },
  async ({ html, ...rest }) => {
    try {
      // `url` is for add-ons before 0.2.4, which framed the card from this server.
      return text(await bridge.call('show_card', { ...rest, html, url: bridge.addCard(html) }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  },
);

tool('close_cards', 'Close the cards you put on the page with show_card.', { tabId });

tool(
  'screenshot',
  'Take a screenshot of the tab\'s visible viewport. Pixel positions in the image are the coordinates click/hover/scroll accept.',
  { tabId },
  {
    format: (r) => ({
      content: [
        { type: 'image', data: r.data, mimeType: r.mimeType },
        { type: 'text', text: `Viewport ${r.width}x${r.height} — ${r.url}${process.env.CLAUDE_FOR_ZEN_DEBUG ? ` [${r.method}]` : ''}` },
      ],
    }),
  },
);

tool(
  'javascript',
  'Run JavaScript in the page and return the value of the last expression (a promise is awaited). Top-level `return` and `await` are not allowed: to use await, end with an async function call, e.g. (async () => { const r = await fetch(url); return r.status; })(). Write the code as ONE expression (an arrow function call is fine): some sites forbid eval, and there only a single expression, or statements ending in `return`, will work.',
  { tabId, code: z.string() },
  { timeout: 60_000 },
);

tool(
  'wait_for',
  'Wait until text or a CSS selector appears on the page, or just for a number of seconds.',
  {
    tabId,
    text: z.string().optional(),
    selector: z.string().optional(),
    seconds: z.number().optional().describe('Timeout (or plain wait if no text/selector), default 10, max 30'),
  },
  { timeout: 40_000 },
);

tool(
  'console_messages',
  'Read console output and uncaught errors captured from a tab since it was opened or last cleared.',
  {
    tabId,
    pattern: z.string().optional().describe('Regex filter on the message text'),
    onlyErrors: z.boolean().optional(),
    limit: z.number().int().optional().describe('Most recent N, default 100'),
    clear: z.boolean().optional().describe('Clear the buffer after reading'),
  },
);

tool(
  'network_requests',
  'Read the network requests a tab has made (method, URL, status, type) since it was opened or last cleared.',
  {
    tabId,
    pattern: z.string().optional().describe('Regex filter on the URL'),
    limit: z.number().int().optional().describe('Most recent N, default 100'),
    clear: z.boolean().optional().describe('Clear the buffer after reading'),
  },
);

tool('resize_window', 'Resize the browser window containing a tab.', {
  tabId,
  width: z.number().int(),
  height: z.number().int(),
});

await bridge.listen();
await server.connect(new StdioServerTransport());

const shutdown = () => {
  bridge.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
