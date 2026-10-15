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

import { readEnvKeys, updateEnvKeys } from './env-file.js';

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
}

export interface PhonePort {
  status(): Promise<PhoneStatus>;
  /** Make a new token, store it and return it (once). Ends the app's connection made with the old one. */
  newToken(): Promise<string>;
  /** Turn the channel on or off in `.env`; it takes effect when NanoClaw starts. Needs a token to turn on. */
  setEnabled(enabled: boolean): Promise<void>;
}

export class PhoneError extends Error {
  constructor(
    readonly code: 'not_installed' | 'token_missing',
    message: string,
  ) {
    super(message);
    this.name = 'PhoneError';
  }
}

/** The channel refuses tokens shorter than this. */
export const MIN_TOKEN_LENGTH = 32;

export const ENV_KEYS = ['VOICE_ENABLED', 'VOICE_AUTH_TOKEN', 'VOICE_BIND_HOST', 'VOICE_CHANNEL_PORT'] as const;

export interface RecordedStatus {
  listening: boolean;
  connected: boolean;
  connectedAt: string | null;
  lastDisconnectAt: string | null;
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
}

export function createPhonePort(options: PhoneOptions): PhonePort {
  const envFile = path.join(options.projectRoot, '.env');
  const dataDir = path.join(options.projectRoot, 'data');

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
  };
}
