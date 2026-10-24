/**
 * The phone app (NanoVoice) page of the panel: whether the voice channel is on and listening, whether the app is
 * connected, the address to give it, and the token that lets it in.
 *
 * It depends on nothing from the `add-voice` skill. It reads the settings in `.env`, a small status file the voice
 * channel writes (`data/voice-status.json`, no secrets in it), and the push file only to know that one exists. The
 * token is never shown after it is made: the panel can make a new one (which ends the app's current connection,
 * because the channel checks the token at every login and when it changes) and shows it once.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomic-file.js';
import { readEnvKeys, updateEnvKeys } from './env-file.js';
import { qrMatrix, type QrMatrix } from './qr.js';

export interface PhoneStatus {
  /** The voice channel is part of this install (the `add-voice` skill). */
  installed: boolean;
  /** `VOICE_ENABLED` is on in `.env`. */
  enabled: boolean;
  /** The channel is listening right now (it was started with the setting on). */
  listening: boolean;
  connected: boolean;
  connectedAt: string | null;
  lastDisconnectAt: string | null;
  locale: string | null;
  /** The address to enter in the app, when there is a usable one. */
  url: string | null;
  /** Why there is no usable address, as a stable code. */
  addressProblem: 'loopback' | 'all_addresses' | null;
  tokenSet: boolean;
  /** The app has given the server a place to wake it up. */
  pushRegistered: boolean;
  /** Name of the agent the channel is wired to, or null when it is not wired. */
  agent: string | null;
  /** The setting and the running channel disagree: a restart is needed. */
  restartNeeded: boolean;
  /** When an app last paired with a code, and which device it said it was. */
  pairedAt: string | null;
  pairedDevice: string | null;
  /** A pairing code is waiting to be used. */
  pairingPending: boolean;
}

export interface PairingStart {
  /** The QR code to draw. Everything the code holds is in it: it is shown once, to the person who asked. */
  matrix: QrMatrix;
  expiresAt: string;
}

export interface PhonePort {
  status(): Promise<PhoneStatus>;
  /** Make a new token, store it and return it (once). Ends the app's connection made with the old one. */
  newToken(): Promise<string>;
  /** Turn the channel on or off in `.env`; it takes effect when NanoClaw starts. Needs a token to turn on. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Leave a one-time pairing code for the voice channel and return the QR code that carries it. */
  startPairing(): Promise<PairingStart>;
  /** Cancel the waiting pairing code, if any. */
  cancelPairing(): Promise<void>;
}

export class PhoneError extends Error {
  constructor(
    readonly code: 'not_installed' | 'token_missing' | 'no_address',
    message: string,
  ) {
    super(message);
    this.name = 'PhoneError';
  }
}

/** The channel refuses tokens shorter than this. */
export const MIN_TOKEN_LENGTH = 32;

/** How long a pairing code works. The voice channel enforces it; this is what the file says. */
export const PAIRING_TTL_MS = 5 * 60_000;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/** 16 random characters of the pairing alphabet: 80 bits. */
export function makePairingCode(randomBytes: (n: number) => Buffer = crypto.randomBytes): string {
  return Array.from(randomBytes(16), (byte) => CODE_ALPHABET[byte & 31]).join('');
}

/** The text of the QR code (see "Abbinamento con un QR" in the app's protocol). */
export function pairingLink(serverUrl: string, code: string): string {
  return `nanovoice://pair?v=1&server=${encodeURIComponent(serverUrl)}&code=${code}`;
}

export const ENV_KEYS = ['VOICE_ENABLED', 'VOICE_AUTH_TOKEN', 'VOICE_BIND_HOST', 'VOICE_CHANNEL_PORT'] as const;

export interface RecordedStatus {
  listening: boolean;
  connected: boolean;
  connectedAt: string | null;
  lastDisconnectAt: string | null;
  pairedAt: string | null;
  pairedDevice: string | null;
  locale: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** The channel's status file, checked field by field: it is data on disk, not trusted. Null when absent or unreadable. */
export function readRecordedStatus(file: string): RecordedStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or damaged file just means no status
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const data = parsed as Record<string, unknown>;
  const stamp = (value: unknown): string | null => (typeof value === 'string' && ISO.test(value) ? value : null);
  return {
    listening: data.listening === true,
    connected: data.connected === true,
    connectedAt: stamp(data.connectedAt),
    lastDisconnectAt: stamp(data.lastDisconnectAt),
    pairedAt: stamp(data.pairedAt),
    pairedDevice:
      typeof data.pairedDevice === 'string' && /^[\p{L}\p{N} ._-]{1,40}$/u.test(data.pairedDevice)
        ? data.pairedDevice
        : null,
    locale: typeof data.locale === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(data.locale) ? data.locale : null,
  };
}

/** The address the phone should use, or why there is none. */
export function addressFor(
  host: string,
  port: number,
): { url: string; problem: null } | { url: null; problem: 'loopback' | 'all_addresses' } {
  if (host === '0.0.0.0' || host === '::') return { url: null, problem: 'all_addresses' };
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return { url: null, problem: 'loopback' };
  const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return { url: `ws://${shown}:${port}`, problem: null };
}

export interface PhoneOptions {
  projectRoot: string;
  /** Whether the voice channel is installed (a channel registered under that name). */
  installed(): boolean;
  /** Names of the agents the voice channel is wired to. */
  wiredAgents(): Promise<string[]>;
  now?: () => number;
  /** Replaced in tests. */
  matrix?: (text: string) => QrMatrix;
}

export function createPhonePort(options: PhoneOptions): PhonePort {
  const envFile = path.join(options.projectRoot, '.env');
  const dataDir = path.join(options.projectRoot, 'data');
  const pairingFile = path.join(dataDir, 'voice-pairing.json');
  const now = options.now ?? Date.now;
  const pairingPending = (): boolean => {
    try {
      const parsed = JSON.parse(fs.readFileSync(pairingFile, 'utf8')) as { expiresAt?: unknown };
      return typeof parsed.expiresAt === 'string' && Date.parse(parsed.expiresAt) > now();
      // eslint-disable-next-line no-catch-all/no-catch-all -- no file, or a damaged one: nothing is waiting
    } catch {
      return false;
    }
  };

  return {
    async status() {
      const env = readEnvKeys(envFile, ENV_KEYS);
      const installed = options.installed();
      const enabled = env.VOICE_ENABLED === 'true';
      const recorded = readRecordedStatus(path.join(dataDir, 'voice-status.json'));
      const listening = enabled && recorded?.listening === true;
      const port = Number(env.VOICE_CHANNEL_PORT ?? '8767');
      const address = addressFor(env.VOICE_BIND_HOST ?? '127.0.0.1', Number.isInteger(port) ? port : 8767);
      const agents = installed ? await options.wiredAgents() : [];
      return {
        installed,
        enabled,
        listening,
        connected: listening && recorded?.connected === true,
        connectedAt: listening && recorded?.connected ? recorded.connectedAt : null,
        lastDisconnectAt: recorded?.lastDisconnectAt ?? null,
        locale: listening && recorded?.connected ? recorded.locale : null,
        url: address.url,
        addressProblem: address.problem,
        tokenSet: (env.VOICE_AUTH_TOKEN ?? '').length >= MIN_TOKEN_LENGTH,
        pushRegistered: fs.existsSync(path.join(dataDir, 'voice-push.json')),
        agent: agents[0] ?? null,
        // On in the file but not running, or running but switched off in the file.
        restartNeeded: installed && enabled !== (recorded?.listening === true),
        pairedAt: recorded?.pairedAt ?? null,
        pairedDevice: recorded?.pairedDevice ?? null,
        pairingPending: pairingPending(),
      };
    },

    async newToken() {
      if (!options.installed()) throw new PhoneError('not_installed', 'the voice channel is not installed');
      const token = crypto.randomBytes(24).toString('hex');
      updateEnvKeys(envFile, { VOICE_AUTH_TOKEN: token });
      // A file that now holds a token must not be readable by other users of this machine.
      if (fs.statSync(envFile).mode & 0o077) fs.chmodSync(envFile, 0o600);
      return token;
    },

    async setEnabled(enabled) {
      if (!options.installed()) throw new PhoneError('not_installed', 'the voice channel is not installed');
      if (enabled && (readEnvKeys(envFile, ['VOICE_AUTH_TOKEN']).VOICE_AUTH_TOKEN ?? '').length < MIN_TOKEN_LENGTH)
        throw new PhoneError('token_missing', 'make a token first');
      updateEnvKeys(envFile, { VOICE_ENABLED: enabled ? 'true' : 'false' });
    },

    async startPairing() {
      if (!options.installed()) throw new PhoneError('not_installed', 'the voice channel is not installed');
      const env = readEnvKeys(envFile, ENV_KEYS);
      if ((env.VOICE_AUTH_TOKEN ?? '').length < MIN_TOKEN_LENGTH)
        throw new PhoneError('token_missing', 'make a token first');
      const port = Number(env.VOICE_CHANNEL_PORT ?? '8767');
      const address = addressFor(env.VOICE_BIND_HOST ?? '127.0.0.1', Number.isInteger(port) ? port : 8767);
      if (!address.url) throw new PhoneError('no_address', 'the channel has no address the phone can use');
      const code = makePairingCode();
      const expiresAt = new Date(now() + PAIRING_TTL_MS).toISOString();
      fs.mkdirSync(dataDir, { recursive: true });
      // Only the code's hash is kept; the code itself lives in the QR code that is about to be shown.
      writeFileAtomic(
        pairingFile,
        JSON.stringify({ hash: crypto.createHash('sha256').update(code).digest('hex'), expiresAt, attempts: 0 }),
        0o600,
      );
      return { matrix: (options.matrix ?? qrMatrix)(pairingLink(address.url, code)), expiresAt };
    },

    async cancelPairing() {
      fs.rmSync(pairingFile, { force: true });
    },
  };
}
