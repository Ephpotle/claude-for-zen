// Rebuild the chat panel's conversation from a Claude Code transcript.
//
//   node scripts/recover-chat.js            most recent panel session
//   node scripts/recover-chat.js <id>       a specific session id
//   add --keep-current to file it in the history without switching to it
//
// Run it while the chat server is stopped, then start the server: the panel
// shows the conversation again and Claude continues with its full context.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeCall, describeResult, resultText } from '../chat/conversation.js';

const workDir = path.join(process.env.CLAUDE_FOR_ZEN_HOME || path.join(os.homedir(), '.claude-for-zen'), 'chat');
// Claude Code files sessions under the working folder's path with separators replaced.
const projectDir = path.join(os.homedir(), '.claude', 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'));
if (!existsSync(projectDir)) {
  console.error(`No saved sessions at ${projectDir}`);
  process.exit(1);
}

let id = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!id) {
  const newest = readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, t: statSync(path.join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  if (!newest) {
    console.error('No saved sessions found.');
    process.exit(1);
  }
  id = newest.f.replace(/\.jsonl$/, '');
}

const history = [];
const tools = new Map(); // tool_use id -> item
let n = 1;
const add = (item) => (history.push({ ...item, id: 'i' + n++ }), history[history.length - 1]);

for (const line of readFileSync(path.join(projectDir, id + '.jsonl'), 'utf8').split('\n')) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.isSidechain || !entry.message) continue;
  const content = entry.message.content;
  if (entry.type === 'user') {
    if (typeof content === 'string') {
      // Pinned comments are sent with context; show just the comment.
      const comment = content.startsWith('[Comment pinned on the page]') && content.match(/\nComment: ([\s\S]*)$/);
      add({ type: 'user', text: comment ? comment[1] : content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) add({ type: 'user', text: block.text });
        if (block.type !== 'tool_result') continue;
        const item = tools.get(block.tool_use_id);
        if (!item) continue;
        const failed = !!block.is_error;
        Object.assign(item, { state: failed ? 'failed' : 'done' }, describeResult(item.name, item.label, resultText(block.content), failed));
      }
    }
  } else if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text.trim()) add({ type: 'text', text: block.text });
      if (block.type === 'tool_use') {
        tools.set(block.id, add({ type: 'tool', toolUseId: block.id, name: block.name, label: describeCall(block.name, block.input), state: 'stopped' }));
      }
    }
  }
}

const first = history.find((i) => i.type === 'user');
if (!first) {
  console.error(`Session ${id} has no messages to recover.`);
  process.exit(1);
}
const storeDir = path.join(workDir, 'conversations');
mkdirSync(storeDir, { recursive: true });
const key = id.replace(/-/g, '').slice(0, 16);
const title = first.text.replace(/\s+/g, ' ').trim().slice(0, 70);
writeFileSync(path.join(storeDir, key + '.json'), JSON.stringify({ id: key, title, updatedAt: statSync(path.join(projectDir, id + '.jsonl')).mtimeMs, sessionId: id, nextId: n, history }));
if (!process.argv.includes('--keep-current')) writeFileSync(path.join(workDir, 'current.txt'), key);
console.log(`Recovered session ${id}: ${history.filter((i) => i.type === 'user').length} messages from you, ${history.filter((i) => i.type === 'text').length} replies, ${tools.size} steps.`);
