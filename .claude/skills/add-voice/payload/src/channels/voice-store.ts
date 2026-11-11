/**
 * The voice channel's small state files in the data folder: the time of the last message, the phone's push endpoint,
 * what waits for the phone while it is offline, the token of `POST /notify`, the pending pairing code and the status
 * the manager panel shows. Each is written whole (a new file renamed over it) with mode 0600; a missing or damaged one
 * reads as nothing.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { isValidEndpoint, type PushPolicy } from './voice-net.js';

/** Alerts and files kept for the app while it is offline: the newest ones (files are large). */
export const PENDING_NOTIFY_MAX = 50;
export const PENDING_FILES_MAX = 4;
/** A token shorter than this is refused: it guards the phone's actions and the agent. */
export const MIN_TOKEN_LENGTH = 32;

/** Writes [value] as JSON, whole or not at all, mode 0600; throws on failure. */
export function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** The parsed JSON object in [file], or null when it is missing, damaged or not an object. */
function readJsonObject(file: string | null | undefined): Record<string, unknown> | null {
  if (!file) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or damaged state file reads as nothing
  } catch {
    return null;
  }
}

export interface Activity {
  /** When the last message went one way or the other (ms); 0 when not known. */
  at: number;
  /** The app was told the pause is over: the next message starts a new conversation. */
  pauseAnnounced: boolean;
}

export function loadActivity(file: string | null | undefined): Activity {
  const parsed = readJsonObject(file);
  return {
    at: typeof parsed?.last_message_at === 'number' ? parsed.last_message_at : 0,
    pauseAnnounced: parsed?.pause_announced === true,
  };
}

export function saveActivity(file: string, activity: Activity): void {
  writePrivateJson(file, {
    last_message_at: activity.at,
    ...(activity.pauseAnnounced ? { pause_announced: true } : {}),
  });
}

/** The phone's UnifiedPush endpoint remembered across restarts, if it is still a valid one. */
export function loadPushEndpoint(file: string | null | undefined, policy: PushPolicy): string | null {
  const url = readJsonObject(file)?.url;
  return typeof url === 'string' && isValidEndpoint(url, policy) ? url : null;
}

export function savePushEndpoint(file: string, url: string | null): void {
  if (url) writePrivateJson(file, { url });
  else fs.rmSync(file, { force: true });
}

export interface Pending {
  notify: string[];
  /** `file` frames, as made for an app that shows pictures. */
  files: Record<string, unknown>[];
}

/** What was waiting for the phone when the host stopped: alerts and file frames; nothing when unreadable. */
export function loadPending(file: string | null | undefined): Pending {
  const parsed = readJsonObject(file);
  const notify = Array.isArray(parsed?.notify) ? parsed.notify.filter((t): t is string => typeof t === 'string') : [];
  const files = Array.isArray(parsed?.files)
    ? parsed.files.filter(
        (f): f is Record<string, unknown> =>
          !!f && typeof f === 'object' && !Array.isArray(f) && (f as { type?: unknown }).type === 'file',
      )
    : [];
  return { notify: notify.slice(-PENDING_NOTIFY_MAX), files: files.slice(-PENDING_FILES_MAX) };
}

/** Written at each change: a restart of the host keeps what the phone has not received yet. Empty: no file. */
export function savePending(file: string, pending: Pending): void {
  if (pending.notify.length === 0 && pending.files.length === 0) fs.rmSync(file, { force: true });
  else writePrivateJson(file, pending);
}

/** The token of `POST /notify`, made the first time (32 random bytes, a 0600 file only this user reads); throws. */
export function loadNotifyToken(file: string): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= MIN_TOKEN_LENGTH) return existing;
  } catch {
    // not there yet: made below
  }
  const token = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // mode only applies when the file is created
  return token;
}

export interface Pairing {
  /** SHA-256 of the code, hex. */
  hash: string;
  expiresAt: number;
  /** Wrong codes tried so far. */
  attempts: number;
}

/** The pairing code the manager panel left (see docs/PROTOCOL.md of the app, "Abbinamento con un QR"), if any. */
export function readPairing(file: string | null | undefined): Pairing | null {
  const parsed = readJsonObject(file);
  if (!parsed) return null;
  const expiresAt = typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : NaN;
  if (typeof parsed.hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.hash) || !Number.isFinite(expiresAt))
    return null;
  const attempts = typeof parsed.attempts === 'number' && Number.isInteger(parsed.attempts) ? parsed.attempts : 0;
  return { hash: parsed.hash, expiresAt, attempts };
}

export function writePairing(file: string, pairing: Pairing): void {
  writePrivateJson(file, { ...pairing, expiresAt: new Date(pairing.expiresAt).toISOString() });
}
