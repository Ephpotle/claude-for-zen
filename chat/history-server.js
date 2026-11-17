#!/usr/bin/env node
// Claude for Zen — earlier conversations, for the chat panel's Claude.
//
// A small MCP server over stdio that reads the panel's saved conversations
// (one JSON file each), so that a new conversation can look up what an earlier
// one did: "do here what you did for that other site". Read-only.
//
//   node history-server.js <folder with the conversation files>

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dir = process.argv[2];
const server = new McpServer({ name: 'claude-for-zen-history', version: '0.1.0' });
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const clip = (value, n) => {
  const s = String(value ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function load() {
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const saved = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
      if (Array.isArray(saved.history) && saved.history.length) out.push(saved);
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** One item of a conversation as a line or block of plain text. */
function render(item, full) {
  const limit = full ? 20000 : 600;
  switch (item.type) {
    case 'user': return `USER: ${clip(item.text, limit)}`;
    case 'text': return `CLAUDE: ${clip(item.text, limit)}`;
    case 'tool': return `  step (${item.state}): ${item.label}${item.input ? `\n    input: ${clip(item.input, full ? 8000 : 300)}` : ''}${item.detail ? `\n    ${clip(item.detail, 300)}` : ''}`;
    case 'ask': return `  asked the user (${item.state}): ${item.title}\n${clip(item.body, full ? 12000 : 300).split('\n').map((l) => '    ' + l).join('\n')}`;
    case 'error': return `  error: ${clip(item.text, 400)}`;
    case 'figure': return `  drew a figure in the chat: ${item.title || 'untitled'}${full ? `\n    html: ${clip(item.html, 6000)}` : ''}`;
    default: return '';
  }
}
const searchable = (saved) => [saved.title, ...saved.history.map((i) => [i.text, i.label, i.input, i.title, i.body].filter(Boolean).join(' '))].join('\n').toLowerCase();
const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'unknown date');

server.registerTool(
  'conversations_search',
  {
    description:
      'Find earlier conversations from this chat panel. Returns id, date and title, newest first, with the lines that matched. `query` is words that must all appear somewhere in the conversation (a site name, a tool, a topic); leave it out to list the most recent ones.',
    inputSchema: {
      query: z.string().optional().describe('Words that must all appear, e.g. "aftonbladet script"'),
      limit: z.number().int().optional().describe('How many to return, default 10'),
    },
  },
  async ({ query, limit = 10 }) => {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const found = [];
    for (const saved of load()) {
      const hay = searchable(saved);
      if (!words.every((w) => hay.includes(w))) continue;
      const hits = words.length
        ? saved.history
            .map((item) => render(item, false))
            .filter((line) => line && words.some((w) => line.toLowerCase().includes(w)))
            .slice(0, 3)
            .map((line) => '    ' + clip(line.replace(/\s+/g, ' '), 220))
        : [];
      found.push(`${saved.id} | ${date(saved.updatedAt)} | ${saved.history.filter((i) => i.type === 'user').length} messages | ${clip(saved.title, 90)}${hits.length ? '\n' + hits.join('\n') : ''}`);
      if (found.length >= limit) break;
    }
    return text(found.length ? found.join('\n') : `No earlier conversation matches${words.length ? ` "${query}"` : ''}. Try fewer or different words.`);
  },
);

server.registerTool(
  'conversation_read',
  {
    description:
      'Read an earlier conversation by id (from conversations_search): what the user asked, what Claude said, each step taken with its input, and what the user was asked to allow (including the full code of saved userscripts). Long conversations come in parts; pass the `next` value it returns as `from`.',
    inputSchema: {
      id: z.string().describe('Conversation id'),
      from: z.number().int().optional().describe('Item to start at, default 0'),
    },
  },
  async ({ id, from = 0 }) => {
    const saved = /^[0-9a-f]{16}$/.test(id) ? load().find((s) => s.id === id) : null;
    if (!saved) return { isError: true, content: [{ type: 'text', text: `No conversation with id ${id}.` }] };
    const out = [`Conversation ${saved.id}, last used ${date(saved.updatedAt)}: ${saved.title}`, ''];
    let size = 0;
    let i = from;
    for (; i < saved.history.length; i++) {
      const block = render(saved.history[i], true);
      if (!block) continue;
      if (size + block.length > 40000 && size > 0) break;
      out.push(block);
      size += block.length;
    }
    out.push('', i < saved.history.length ? `More follows: call again with from: ${i}` : 'End of conversation.');
    return text(out.join('\n'));
  },
);

// The chat server watches for this call and puts the drawing into the panel;
// nothing needs doing here.
server.registerTool(
  'chat_draw',
  {
    description:
      'Draw a figure in the chat panel itself, as part of your reply: a chart, diagram, bracket, timeline. Give self-contained HTML or SVG (inline <style> and <script> are fine; no network, so no external scripts, fonts or images). The panel is narrow, about 300 to 420 pixels wide: make it fluid (width: 100%, an SVG viewBox) and support light and dark with prefers-color-scheme. Follow it with a sentence or two of text; do not repeat the figure as text.',
    inputSchema: {
      html: z.string().describe('A complete HTML document, or body content (an <svg> alone is fine)'),
      title: z.string().optional().describe('Caption shown above the figure'),
      height: z.number().int().optional().describe('Height in pixels, default 320'),
    },
  },
  async ({ html }) => (String(html).trim() ? text('The figure is now showing in the chat.') : { isError: true, content: [{ type: 'text', text: 'The figure has no content.' }] }),
);

server.registerTool(
  'report_to_developer',
  {
    description:
      'File a report for the person developing this chat panel and its browser tools: something broken, something missing, an idea. It is saved where their development session reads it; it is not delivered instantly. Be concrete: what you tried, what happened, what is needed.',
    inputSchema: {
      title: z.string().describe('One line'),
      text: z.string().describe('The report'),
    },
  },
  async ({ title, text: body }) => {
    try {
      const folder = path.join(dir, '..', '..', 'dev-reports');
      mkdirSync(folder, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'report';
      const file = path.join(folder, `${stamp}-${slug}.md`);
      writeFileSync(file, `# ${String(title).trim()}\n\nFiled ${new Date().toISOString()} from the Zen chat panel.\n\n${String(body).trim()}\n`);
      return text(`Filed for the developer: ${file}`);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Could not save the report: ${err.message}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
process.stdin.on('close', () => process.exit(0));
