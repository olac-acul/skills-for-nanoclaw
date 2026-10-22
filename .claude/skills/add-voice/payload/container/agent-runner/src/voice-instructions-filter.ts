/**
 * The voice section of the agent's instructions (between the add-voice markers) matters only in the voice app's
 * conversation, but NanoClaw composes one CLAUDE.md per agent, read by all of its conversations. For a session of
 * another channel (Telegram, the terminal) OpenCode is given a copy without that section: about 1,300 tokens less in
 * every prompt there. The voice session, and a session bound to no chat (a scheduled task), keep the whole file.
 *
 * Used where the OpenCode provider lists its instruction files (a seam, see scripts/voice-core-seams.mjs). Any problem
 * falls back to the whole file: a section too many is better than none.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import { getSessionRouting } from './db/session-routing.js';

const BEGIN = '<!-- nanovoice:begin';
const END = '<!-- nanovoice:end -->';

/** The text without the voice section (and the blank lines it leaves); unchanged when there is none. */
export function withoutVoiceSection(text: string): string {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(END, start);
  if (end < 0) return text; // a broken section: leave the file as it is
  const before = text.slice(0, start).replace(/\n+$/, '');
  const after = text.slice(end + END.length).replace(/^\n+/, '');
  return before && after ? `${before}\n\n${after}` : before || after;
}

export interface FilterDeps {
  channel: () => string | null;
  dataHome: string;
}

const defaults = (): FilterDeps => ({
  channel: () => getSessionRouting().channel_type,
  dataHome: process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'),
});

/** The instruction file to give OpenCode for this session: [file] itself, or a copy without the voice section. */
export function instructionsForSession(file: string, deps: FilterDeps = defaults()): string {
  try {
    const channel = deps.channel();
    if (!channel || channel === 'voice') return file;
    const text = readFileSync(file, 'utf8');
    const filtered = withoutVoiceSection(text);
    if (filtered === text) return file;
    const out = path.resolve(deps.dataHome, 'nanoclaw-claude-without-voice.md');
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    const temporary = `${out}.${process.pid}.tmp`;
    writeFileSync(temporary, filtered, { mode: 0o600 });
    renameSync(temporary, out);
    return out;
  } catch (error) {
    console.error(`[voice] the instructions keep the voice section: ${String(error).slice(0, 200)}`);
    return file;
  }
}
