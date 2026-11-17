// Violentmonkey userscripts for the chat panel.
//
// Violentmonkey (2.50+) lets an AI agent manage its scripts through the
// official @violentmonkey/mcp server: the server listens on a local port, the
// user opens a "connect" address once per browser start and approves it in
// Violentmonkey's settings, and from then on scripts can be listed, written,
// switched on or off and deleted.
//
// The server has to outlive the Claude process (which is restarted whenever a
// setting changes), or Violentmonkey would need re-approving each time. So one
// copy runs for as long as the chat server does, and Claude talks to it over
// HTTP.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VM = 'mcp__violentmonkey__';
// Looking is free; anything that changes scripts or runs code asks first.
export const VM_READ = ['vm_status', 'scripts_list', 'scripts_get', 'scripts_test_match', 'tabs_list', 'tab_scripts', 'script_logs', 'script_handlers', 'script_results'].map((t) => VM + t);

const PORT = Number(process.env.CLAUDE_FOR_ZEN_VM_PORT) || 47811;
let running = null; // { child, token }

const cliPath = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@violentmonkey', 'mcp', 'dist', 'cli.js');

export const userscriptsAvailable = () => existsSync(cliPath());

/** Starts the Violentmonkey server if it is not running; returns the MCP server entry for Claude. */
export function userscriptServer(home) {
  if (!running) {
    const tokenFile = path.join(home, 'violentmonkey-token');
    let token = '';
    try {
      token = readFileSync(tokenFile, 'utf8').trim();
    } catch {}
    if (!/^[0-9a-f]{32,}$/.test(token)) {
      token = randomBytes(24).toString('hex');
      writeFileSync(tokenFile, token, { mode: 0o600 });
    }
    // stdin stays open: the server shuts down when its stdin ends.
    const child = spawn(process.execPath, [cliPath(), '--transport', 'http', '--port', String(PORT), '--token', token], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    running = { child, token };
    child.on('exit', () => {
      if (running?.child === child) running = null;
    });
    process.once('exit', () => child.kill());
  }
  return { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: `Bearer ${running.token}` } };
}

export function stopUserscriptServer() {
  running?.child.kill();
  running = null;
}

export const VM_PROMPT = `

Violentmonkey: the ${VM}* tools manage the user's userscripts, which is how a change to a page is made permanent. Use them when the user asks to keep a change you made, to apply something on every visit, or to list, switch off, fix or remove a script.
- Start with vm_status. If it says Violentmonkey is not connected, open its connectUrl in a new tab (tab_create), tell the user to press Approve on the Violentmonkey page that appears, and wait for them to say it is done. This is needed once each time the browser starts. If that page does not appear, Violentmonkey 2.50 or newer is probably not installed; say so.
- Before saving, get the change working on the live page with the javascript tool, so the script you save is known to work.
- Write a complete userscript with a metadata block: @name (short and descriptive), @namespace claude-for-zen, @version, @description, the narrowest @match that covers what the user asked for (one site, not everything), @grant none unless a GM function is really needed, and @run-at document-start only when it must act before the page draws. Pure styling should add a <style> element rather than poll the page. Content that appears later needs a MutationObserver, not a timer loop.
- To change a script, find it with scripts_list, read it with scripts_get, and call scripts_write with its id and the whole new code, raising @version. Never create a second script for the same job.
- Saving, enabling, disabling and deleting are confirmed by the user in the panel. If the user has switched on "update without asking", a change to a script they already allowed is applied straight away as long as its header (the ==UserScript== block) is unchanged apart from @version and @description; any other header change asks again, so leave the header alone unless the user asked for a different scope. Do not pass the enabled option when updating.
- After an update, reload the page and check the result yourself before saying it is done. Afterwards say what the script is called and that it can be switched off or removed in Violentmonkey's own list.
- script_logs, tab_scripts and script_call only work on tabs the user has granted on Violentmonkey's "AI agent access" settings page. If they refuse, tell the user that; do not retry.
- Userscripts written by other people (from Greasy Fork and the like) are installed by the user, not by you. You can read, explain and adjust ones that are already installed.`;

/**
 * The entries of a script's metadata block as [key, value] pairs, or null when
 * it has no block. Only the lines between "// ==UserScript==" and
 * "// ==/UserScript==" count, because those are all Violentmonkey reads: an
 * "// @match" line anywhere else in the file is just a comment, and must not be
 * taken for one here.
 */
export function metaBlock(code) {
  const lines = String(code ?? '').split(/\r\n|\r|\n/);
  const start = lines.findIndex((line) => /^\s*\/\/\s*==UserScript==\s*$/.test(line));
  if (start < 0) return null;
  const length = lines.slice(start + 1).findIndex((line) => /^\s*\/\/\s*==\/UserScript==\s*$/.test(line));
  if (length < 0) return null;
  const entries = [];
  for (const line of lines.slice(start + 1, start + 1 + length)) {
    const match = /^\s*\/\/\s*@([\w:-]+)(?:\s+(.*))?$/.exec(line);
    if (match) entries.push([match[1].toLowerCase(), (match[2] ?? '').trim()]);
  }
  return entries;
}
const metaAll = (code, keys) => (metaBlock(code) ?? []).filter(([key]) => keys.split('|').includes(key)).map(([, value]) => value);
const metaValue = (code, key) => metaAll(code, key)[0];
const clip = (text, n) => (String(text).length > n ? String(text).slice(0, n - 1) + '…' : String(text));

/** What to show in the trail while a Violentmonkey tool runs, or null if it is not one. */
export function describeScriptCall(name, input = {}) {
  if (!name.startsWith(VM)) return null;
  switch (name.slice(VM.length)) {
    case 'vm_status': return 'Checking the connection to Violentmonkey';
    case 'scripts_list': return 'Looking at your userscripts';
    case 'scripts_get': return 'Reading a userscript';
    case 'scripts_test_match': return 'Checking which pages a script would run on';
    case 'scripts_write': return `${input.id ? 'Updating' : 'Saving'} the userscript “${clip(metaValue(input.code, 'name') ?? 'untitled', 40)}”`;
    case 'scripts_set_enabled': return `Turning a userscript ${input.enabled ? 'on' : 'off'}`;
    case 'scripts_delete': return 'Removing a userscript';
    case 'tabs_list': return 'Looking at the tabs Violentmonkey can see';
    case 'tab_scripts': return 'Looking at the userscripts running in a tab';
    case 'tab_reload': return 'Reloading a tab';
    case 'script_logs': return 'Reading what a userscript logged';
    case 'script_call': return 'Running a userscript function';
    default: return `Using Violentmonkey (${name.slice(VM.length)})`;
  }
}

/** Title and body for the Allow / Don't allow prompt, or null if it is not a Violentmonkey tool. */
export function describeScriptRequest(tool, input = {}) {
  if (!tool.startsWith(VM)) return null;
  const id = input.id ? `Script id ${input.id}` : '';
  switch (tool.slice(VM.length)) {
    case 'scripts_write': {
      const name = metaValue(input.code, 'name') ?? 'untitled';
      const block = metaBlock(input.code);
      const pages = metaAll(input.code, 'match|include');
      const grants = metaAll(input.code, 'grant').filter((g) => g !== 'none');
      const remote = metaAll(input.code, 'require|resource');
      const updates = metaAll(input.code, 'downloadurl|updateurl');
      // A script with no @match or @include runs everywhere; say so plainly.
      const where = !block
        ? 'EVERY website (the script has no header saying where it runs)'
        : pages.length
          ? pages.join(', ')
          : 'EVERY website (its header has no @match line)';
      return {
        title: `${input.id ? 'Update' : 'Save'} the userscript “${clip(name, 50)}” in Violentmonkey? It runs on every visit to the pages below.`,
        body: [
          `Runs on: ${where}`,
          grants.length ? `Extra abilities: ${grants.join(', ')}` : '',
          remote.length ? `Loads code or files from: ${remote.join(', ')}` : '',
          updates.length ? `Replaces itself later from: ${updates.join(', ')} (the new version is not shown to you)` : '',
          input.enabled === true ? 'Switches the script on.' : input.enabled === false ? 'Saved switched off.' : '',
          '',
          String(input.code ?? ''),
        ].filter((line, i) => line || i === 5).join('\n'),
      };
    }
    case 'scripts_set_enabled': return { title: `Turn this userscript ${input.enabled ? 'on' : 'off'}?`, body: id };
    case 'scripts_delete': return { title: 'Remove this userscript from Violentmonkey?', body: id };
    case 'tab_reload': return { title: 'Reload this tab?', body: `Tab ${input.tabId ?? ''}` };
    case 'script_call': return { title: 'Run this userscript function?', body: clip(JSON.stringify(input), 400) };
    default: return { title: `Allow Violentmonkey: ${tool.slice(VM.length)}?`, body: clip(JSON.stringify(input), 300) };
  }
}

// ---------------------------------------------------------------- approvals
//
// "Update without asking": once the user has allowed a script, later changes to
// THAT script go through on their own as long as its header is unchanged.
//
// What is remembered is, per script id, the whole metadata block apart from the
// version and description: where it runs, what it may use, what it loads, where
// it updates itself from, when it runs. Any other change to the header asks
// again. An approval never carries over to a different script, and a script
// that names no pages (so would run everywhere) is never updated silently.

const IGNORED_KEYS = /^(version|description(:.*)?)$/;
/** The part of a script's header that the user agreed to, or null if it has none worth remembering. */
export function scriptScope(code) {
  const block = metaBlock(code);
  if (!block || !block.some(([key]) => key === 'match' || key === 'include')) return null;
  return JSON.stringify(block.filter(([key]) => !IGNORED_KEYS.test(key)).map(([key, value]) => `${key} ${value}`).sort());
}

const approvalsFile = (home) => path.join(home, 'approved-userscripts.json');
const readApprovals = (home) => {
  try {
    const saved = JSON.parse(readFileSync(approvalsFile(home), 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}; // the older list format is dropped
  } catch {
    return {};
  }
};
const approve = (home, id, scope) => {
  const saved = readApprovals(home);
  saved[String(id)] = scope;
  try {
    writeFileSync(approvalsFile(home), JSON.stringify(saved));
  } catch {}
};

// A new script has no id until Violentmonkey has saved it. Its scope waits here
// between the user's Allow and the tool's result, which carries the id.
const awaitingId = new Set();

/** Call when the user allows a scripts_write. */
export function rememberScriptApproval(home, tool, input = {}) {
  if (tool !== VM + 'scripts_write') return;
  const scope = scriptScope(input.code);
  if (!scope) return;
  if (input.id) approve(home, input.id, scope);
  else awaitingId.add(scope);
}

/** Call with the result of a scripts_write the user allowed, to learn a new script's id. */
export function noteScriptSaved(home, code, resultText) {
  const scope = scriptScope(code);
  if (!scope || !awaitingId.has(scope)) return;
  awaitingId.delete(scope);
  const id = /"id"\s*:\s*"?(\d+)"?/.exec(String(resultText ?? ''))?.[1];
  if (id) approve(home, id, scope);
}

/** True for a change to a script the user already allowed, with the same header. */
export function isApprovedScriptUpdate(home, tool, input = {}) {
  if (tool !== VM + 'scripts_write' || !input.id || input.enabled !== undefined) return false;
  const scope = scriptScope(input.code);
  return !!scope && readApprovals(home)[String(input.id)] === scope;
}
