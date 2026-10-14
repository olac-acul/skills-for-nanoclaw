/**
 * Helpers for `scripts/voice-setup.ts`: the pieces that edit files, kept free of I/O decisions so they can be
 * tested. Nothing here talks to NanoClaw or the network.
 */
import { randomBytes } from 'node:crypto';

export const SECTION_BEGIN =
  '<!-- nanovoice:begin (managed by the add-voice skill: edits between the markers are replaced on update) -->';
export const SECTION_END = '<!-- nanovoice:end -->';

const BEGIN_RE = /<!-- nanovoice:begin[^>]*-->/;

/** A random token of 24 bytes in hex (48 characters). */
export function generateToken(): string {
  return randomBytes(24).toString('hex');
}

/** Tokens shorter than this are refused by the channel anyway; checked here to fail before a restart. */
export function validToken(token: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{24,256}$/.test(token);
}

export interface EnvUpdate {
  [key: string]: string | null;
}

/**
 * Set or remove keys in a `.env` file's text, leaving every other line (comments, order, unknown keys) as it
 * was. A key that exists more than once is set on its last line, which is the one the loader uses.
 */
export function upsertEnv(text: string, updates: EnvUpdate): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`not a valid environment variable name: ${key}`);
    if (value !== null && /[\n\r\0]/.test(value)) throw new Error(`${key}: the value contains a line break`);
    const own = (line: string) => line.startsWith(`${key}=`);
    const at = lines.map(own).lastIndexOf(true);
    if (value === null) {
      for (let i = lines.length - 1; i >= 0; i--) if (own(lines[i]!)) lines.splice(i, 1);
    } else if (at >= 0) {
      lines[at] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function readEnvValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split('\n')) if (line.startsWith(`${key}=`)) found = line.slice(key.length + 1).trim();
  return found?.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * Put the voice instructions into a group's standing-instructions file: replace the block between the markers,
 * or append one (with a blank line before it) when there is none. Everything outside the markers is kept.
 */
export function mergeSection(existing: string, section: string): string {
  const body = `${SECTION_BEGIN}\n${section.trim()}\n${SECTION_END}`;
  const begin = BEGIN_RE.exec(existing);
  if (begin) {
    const start = begin.index;
    const endAt = existing.indexOf(SECTION_END, start);
    if (endAt < 0)
      throw new Error('the instructions file has a nanovoice begin marker without its end marker; fix it by hand');
    return `${existing.slice(0, start)}${body}${existing.slice(endAt + SECTION_END.length)}`;
  }
  if (existing.includes(SECTION_END))
    throw new Error('the instructions file has a nanovoice end marker without its begin marker; fix it by hand');
  if (existing.trim() === '') return `${body}\n`;
  return `${existing.replace(/\s*$/, '')}\n\n${body}\n`;
}

/** The inverse of `mergeSection`: take the block out (the blank line before it too). */
export function removeSection(existing: string): string {
  const begin = BEGIN_RE.exec(existing);
  if (!begin) return existing;
  const endAt = existing.indexOf(SECTION_END, begin.index);
  if (endAt < 0)
    throw new Error('the instructions file has a nanovoice begin marker without its end marker; fix it by hand');
  const before = existing.slice(0, begin.index).replace(/\s*$/, '');
  const after = existing.slice(endAt + SECTION_END.length).replace(/^\s*/, '');
  return before === '' ? after : after === '' ? `${before}\n` : `${before}\n\n${after}`;
}

export interface VoiceSettings {
  enabled: boolean;
  host: string;
  port: number;
  hasToken: boolean;
}

export function readSettings(env: string): VoiceSettings {
  return {
    enabled: readEnvValue(env, 'VOICE_ENABLED') === 'true',
    host: readEnvValue(env, 'VOICE_BIND_HOST') ?? '127.0.0.1',
    port: Number(readEnvValue(env, 'VOICE_CHANNEL_PORT') ?? '8767'),
    hasToken: validToken(readEnvValue(env, 'VOICE_AUTH_TOKEN') ?? ''),
  };
}

/** An address the phone can use, or a reason it cannot. `0.0.0.0` listens everywhere: the phone needs a real address. */
export function pairingAddress(settings: VoiceSettings, reachableAs?: string): { url: string } | { problem: string } {
  const host = reachableAs ?? settings.host;
  if (host === '0.0.0.0' || host === '::')
    return { problem: 'the channel listens on every address; pass --address with the one the phone should use' };
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1')
    return {
      problem:
        'the channel listens on this machine only; set --bind to the address of a private network or VPN the phone reaches',
    };
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return { url: `ws://${bracketed}:${settings.port}` };
}

/** Whether a bind address is a literal that a person typed correctly (IPv4, IPv6 or a short host name). */
export function validBindHost(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((part) => Number(part) <= 255);
  if (host.includes(':')) return /^[0-9A-Fa-f:.]+$/.test(host);
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(host);
}
