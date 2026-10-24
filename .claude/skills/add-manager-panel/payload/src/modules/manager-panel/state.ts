/**
 * The panel's own private state: the administrator credential, the login
 * throttle, the audit log and the key that makes public identifiers opaque.
 * It lives in a directory only the NanoClaw user can read (0700).
 *
 * - `admin.json`: password hash and a session generation. Bumping the
 *   generation (password change, local reset) revokes every session.
 * - `throttle.json`: failed-login counter and lock time, so a restart does not
 *   reset the rate limit.
 * - `audit.jsonl`: one line per state-changing request: time, endpoint,
 *   status and request id. Never bodies, paths, cookies or values.
 * - `id-key`: random key for the HMAC that turns internal ids into opaque ones.
 * - `setup.json`: the one-time first-run code.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './atomic-file.js';
import { isPasswordRecord } from './password.js';

export interface AdminRecord {
  schema: 'manager-panel-admin/v1';
  password: string;
  generation: number;
  updated_at: string;
}

export interface SetupRecord {
  code: string;
  expires_at: string;
}

export interface ThrottleRecord {
  failures: number;
  locked_until: string | null;
  /** Start of the window the failures are counted in (absent in records written by older versions). */
  window_start?: string;
}

const AUDIT_MAX_BYTES = 8 * 1024 * 1024;

export class PanelState {
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.mode & 0o077) {
      throw new Error('panel state directory must be private (mode 0700)');
    }
  }

  private file(name: string): string {
    return path.join(this.directory, name);
  }

  private readText(name: string, maxBytes = 64 * 1024): string | null {
    const file = this.file(name);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.mode & 0o077 || info.size > maxBytes) {
      throw new Error(`panel state file ${name} is not private`);
    }
    return fs.readFileSync(file, 'utf8');
  }

  private readJson<T>(name: string): T | null {
    const text = this.readText(name);
    return text === null ? null : (JSON.parse(text) as T);
  }

  private writeText(name: string, text: string): void {
    writeFileAtomic(this.file(name), text, 0o600);
  }

  private writeJson(name: string, value: unknown): void {
    this.writeText(name, JSON.stringify(value, null, 2) + '\n');
  }

  admin(): AdminRecord | null {
    const record = this.readJson<AdminRecord>('admin.json');
    if (!record) return null;
    if (
      record.schema !== 'manager-panel-admin/v1' ||
      typeof record.password !== 'string' ||
      !isPasswordRecord(record.password) ||
      !Number.isSafeInteger(record.generation)
    ) {
      throw new Error('panel admin record is invalid');
    }
    return record;
  }

  /** Store a new hash and revoke every existing session. */
  setPassword(hash: string, now: Date): AdminRecord {
    const previous = this.admin();
    const record: AdminRecord = {
      schema: 'manager-panel-admin/v1',
      password: hash,
      generation: (previous?.generation ?? 0) + 1,
      updated_at: now.toISOString(),
    };
    this.writeJson('admin.json', record);
    return record;
  }

  /** Store a stronger hash of the same password: not a credential change, so sessions stay valid. */
  replaceHash(hash: string, now: Date): void {
    const previous = this.admin();
    if (!previous) return;
    this.writeJson('admin.json', { ...previous, password: hash, updated_at: now.toISOString() });
  }

  /** Revoke every session without changing the password. */
  revokeSessions(now: Date): void {
    const previous = this.admin();
    if (!previous) return;
    this.writeJson('admin.json', { ...previous, generation: previous.generation + 1, updated_at: now.toISOString() });
  }

  /** The pending first-run setup code, or null when none or expired. */
  setupCode(now: Date): SetupRecord | null {
    const record = this.readJson<SetupRecord>('setup.json');
    if (!record || typeof record.code !== 'string' || !(Date.parse(record.expires_at) > now.getTime())) return null;
    return record;
  }

  /** Reuse the pending code or create one; refused once an administrator exists. */
  ensureSetupCode(now: Date, generate: () => string, lifetimeMs: number): SetupRecord {
    if (this.admin()) throw new Error('an administrator already exists');
    const current = this.setupCode(now);
    if (current) return current;
    const record = { code: generate(), expires_at: new Date(now.getTime() + lifetimeMs).toISOString() };
    this.writeJson('setup.json', record);
    return record;
  }

  clearSetupCode(): void {
    fs.rmSync(this.file('setup.json'), { force: true });
  }

  throttle(): ThrottleRecord {
    return this.readJson<ThrottleRecord>('throttle.json') ?? { failures: 0, locked_until: null };
  }

  setThrottle(record: ThrottleRecord): void {
    this.writeJson('throttle.json', record);
  }

  /** Key for opaque identifiers; created on first use. */
  idKey(): Buffer {
    const existing = this.readText('id-key', 256);
    if (existing && /^[0-9a-f]{64}$/.test(existing.trim())) return Buffer.from(existing.trim(), 'hex');
    const key = randomBytes(32);
    this.writeText('id-key', `${key.toString('hex')}\n`);
    return key;
  }

  /** Free-form JSON documents for features that need a journal (model changes). */
  readDocument<T>(name: string): T | null {
    return this.readJson<T>(name);
  }

  writeDocument(name: string, value: unknown): void {
    this.writeJson(name, value);
  }

  removeDocument(name: string): void {
    fs.rmSync(this.file(name), { force: true });
  }

  audit(entry: { at: string; endpoint: string; status: number; request_id: string }): void {
    const file = this.file('audit.jsonl');
    try {
      if (fs.statSync(file).size > AUDIT_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
}
