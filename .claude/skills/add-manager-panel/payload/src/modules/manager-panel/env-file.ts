/**
 * Minimal, careful `.env` editing: change named keys, leave every other line
 * (comments, ordering, unknown keys) exactly as it was, write atomically and
 * keep the file private. Values are restricted to a conservative character set
 * so nothing typed in a browser can inject another line or a quote.
 */
import fs from 'node:fs';

import { writeFileAtomic } from './atomic-file.js';

const KEY = /^[A-Z][A-Z0-9_]*$/;
// `[` and `]` are literal in an unquoted .env value; they let an IPv6 endpoint such as http://[fd00::1]:8000/v1 through.
const SAFE_VALUE = /^[A-Za-z0-9._:/@+=,%[\]-]{0,2048}$/;
// A value that needs no quoting at all, even if it was typed by hand (`~`, for example).
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being excluded
const PLAIN_VALUE = /^[^\s'"`$\\#\u0000-\u001f\u007f]{0,2048}$/;

export class EnvFileError extends Error {
  constructor(
    readonly code: 'invalid_key' | 'invalid_value',
    message: string,
  ) {
    super(message);
    this.name = 'EnvFileError';
  }
}

function lineKey(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(trimmed);
  if (quoted) return quoted[2];
  return trimmed.replace(/\s+#.*$/, ''); // an unquoted value ends at an inline comment
}

/**
 * How a value read from the file is written back: as is when it needs no quoting, in single quotes
 * otherwise, null when it cannot be represented on one line.
 */
function restoredText(value: string): string | null {
  if (PLAIN_VALUE.test(value)) return value;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being excluded
  if (value.length > 2048 || /[\u0000-\u001f\u007f']/.test(value)) return null;
  return `'${value}'`;
}

/** Whether `updateEnvKeys(..., { restore: true })` can put this previously read value back. */
export function canRestoreValue(value: string | null): boolean {
  return value === null || restoredText(value) !== null;
}

/** Current values of the requested keys (null when absent). The last assignment wins. */
export function readEnvKeys(file: string, keys: readonly string[]): Record<string, string | null> {
  const result: Record<string, string | null> = Object.fromEntries(keys.map((key) => [key, null]));
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const line of text.split('\n')) {
    const key = lineKey(line);
    if (key && key in result) result[key] = unquote(line.slice(line.indexOf('=') + 1));
  }
  return result;
}

/**
 * Set (string) or remove (null) keys. Returns the previous values so a caller
 * can restore them. Existing assignments are replaced in place; new keys are
 * appended; duplicates of a changed key are dropped.
 */
export function updateEnvKeys(
  file: string,
  changes: Record<string, string | null>,
  options: { restore?: boolean } = {},
): Record<string, string | null> {
  // A restore puts back values that were read from the file, which may have been written by hand
  // and so fail the strict check for new values; they are still kept to one line and quoted if needed.
  const render = (value: string): string | null => (options.restore ? restoredText(value) : value);
  for (const [key, value] of Object.entries(changes)) {
    if (!KEY.test(key)) throw new EnvFileError('invalid_key', `invalid key ${JSON.stringify(key)}`);
    if (value === null) continue;
    if (options.restore ? restoredText(value) === null : !SAFE_VALUE.test(value))
      throw new EnvFileError('invalid_value', `invalid value for ${key}`);
  }
  const before = readEnvKeys(file, Object.keys(changes));
  let text = '';
  let mode = 0o600;
  try {
    text = fs.readFileSync(file, 'utf8');
    mode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const written = new Set<string>();
  const out: string[] = [];
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const line of lines) {
    const key = lineKey(line);
    if (!key || !(key in changes)) {
      out.push(line);
      continue;
    }
    const next = changes[key];
    if (next === null || written.has(key)) continue; // removed, or a duplicate of a key already written
    out.push(`${key}=${render(next)}`);
    written.add(key);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== null && !written.has(key)) out.push(`${key}=${render(value)}`);
  }
  writeFileAtomic(file, out.length ? `${out.join('\n')}\n` : '', mode);
  return before;
}
