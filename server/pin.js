// Which add-on the local servers will talk to.
//
// The add-on connects from a moz-extension:// origin that is random per
// browser profile, and web pages cannot forge it. But ANY installed add-on has
// such an origin, so "is it an extension?" is not enough: another add-on could
// connect and pose as this one, then feed Claude instructions or read what it
// does. So the first add-on to connect is remembered, and after that only it is
// accepted.
//
// The remembered origins are one per line in ~/.claude-for-zen/addon-origins.txt.
// Delete a line (or the file) after reinstalling the add-on or to use another
// browser profile; add a line to allow a second one.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = () => process.env.CLAUDE_FOR_ZEN_HOME || path.join(os.homedir(), '.claude-for-zen');
const file = () => path.join(home(), 'addon-origins.txt');
const ORIGIN = /^moz-extension:\/\/[0-9a-f-]{36}$/i;

function known() {
  try {
    return readFileSync(file(), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => ORIGIN.test(line));
  } catch {
    return [];
  }
}

/** True if a connection from this origin may act as the add-on. */
export function addonAllowed(origin) {
  if (typeof origin !== 'string' || !ORIGIN.test(origin)) return false;
  // The tests load a throwaway copy of the add-on, with a new origin each run,
  // against servers of their own; they check for a development install instead.
  if (process.env.CLAUDE_FOR_ZEN_DEV_ONLY) return true;
  const list = known();
  if (list.includes(origin)) return true;
  if (list.length === 0) {
    try {
      mkdirSync(home(), { recursive: true });
      writeFileSync(file(), origin + '\n');
      return true;
    } catch {
      return false;
    }
  }
  console.error(`[claude-for-zen] refused an add-on that is not the one first seen (${origin}). If you reinstalled Claude for Zen or use another profile, add that address to ${file()} or delete the file.`);
  return false;
}
