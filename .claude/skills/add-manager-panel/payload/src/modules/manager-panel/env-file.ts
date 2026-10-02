/**
 * Minimal, careful `.env` editing: change named keys, leave every other line
 * (comments, ordering, unknown keys) exactly as it was, write atomically and
 * keep the file private. Values are restricted to a conservative character set
 * so nothing typed in a browser can inject another line or a quote.
 */
import fs from 'node:fs';

const KEY = /^[A-Z][A-Z0-9_]*$/;
const SAFE_VALUE = /^[A-Za-z0-9._:/@+=,%-]{0,2048}$/;

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
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
export function updateEnvKeys(file: string, changes: Record<string, string | null>): Record<string, string | null> {
  for (const [key, value] of Object.entries(changes)) {
    if (!KEY.test(key)) throw new EnvFileError('invalid_key', `invalid key ${JSON.stringify(key)}`);
    if (value !== null && !SAFE_VALUE.test(value)) throw new EnvFileError('invalid_value', `invalid value for ${key}`);
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
    out.push(`${key}=${next}`);
    written.add(key);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== null && !written.has(key)) out.push(`${key}=${value}`);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, mode);
  try {
    fs.writeSync(fd, out.length ? `${out.join('\n')}\n` : '');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  return before;
}
