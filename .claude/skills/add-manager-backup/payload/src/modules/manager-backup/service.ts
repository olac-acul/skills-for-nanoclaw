/**
 * Backup service: the operations a CLI or a panel calls.
 *
 * Backups live in one directory as `<id>.mbk` plus a small `<id>.meta.json`
 * sidecar with non-sensitive facts (so a list needs no key). The encryption
 * key is generated per backup, handed back exactly once and never written to
 * disk by this service.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createBundle, newBackupId, verifyBundle, type BundleManifest, type VerifyResult } from './bundle.js';
import { formatKey, generateKey, parseKey } from './crypto.js';
import type { BackupHost } from './host.js';
import { restoreInProgress } from './restore.js';

const ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export class BackupError extends Error {
  constructor(
    readonly code: 'agents_busy' | 'restore_running' | 'not_found' | 'invalid_id' | 'exists',
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupRecord {
  id: string;
  createdAt: string;
  /** Size of the encrypted bundle on disk. */
  bytes: number;
  release: string;
  commit: string;
  consistency: BundleManifest['consistency'];
  entries: number;
  files: number;
  contentBytes: number;
  machineIdentity: boolean;
  /** `scheduled` for a backup made by the timer; absent (older sidecars) or `manual` otherwise. */
  trigger?: 'manual' | 'scheduled';
}

export interface CreateOptions {
  includeMachineIdentity?: boolean;
  /**
   * How long to wait for running agent containers to finish before giving up.
   * 0 means do not wait. Only meaningful inside the host process.
   */
  waitMs?: number;
  /** Take the snapshot even if agents are still running (recorded as best-effort). */
  force?: boolean;
  /** The caller has stopped the host (CLI use). */
  hostStopped?: boolean;
  /** Encrypt with this key instead of a fresh random one (scheduled backups). */
  key?: Buffer;
  /** Who started it; recorded in the sidecar. Defaults to manual. */
  trigger?: 'manual' | 'scheduled';
  onProgress?: Parameters<typeof createBundle>[0]['onProgress'];
}

export interface RetentionPolicy {
  keepLast: number;
  keepMonthly: number;
}

export interface ServiceOptions {
  host: BackupHost;
  backupsDir: string;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export class BackupService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;

  constructor(private readonly options: ServiceOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollMs = options.pollMs ?? 500;
  }

  private bundlePath(id: string): string {
    if (!ID_PATTERN.test(id)) throw new BackupError('invalid_id', 'malformed backup id');
    return path.join(this.options.backupsDir, `${id}.mbk`);
  }

  private metaPath(id: string): string {
    return this.bundlePath(id).replace(/\.mbk$/, '.meta.json');
  }

  /** Create a backup. Resolves with the record and the key, which is not stored anywhere. */
  async create(options: CreateOptions = {}): Promise<{ record: BackupRecord; key: string }> {
    const { host } = this.options;
    // A scheduled backup must not copy an install a restore is halfway through replacing.
    if (restoreInProgress(host.projectRoot))
      throw new BackupError(
        'restore_running',
        'a restore, rollback or commit is running on this install; try again later',
      );
    const counter = host.busyAgentCount;
    let before = 0;
    if (counter) {
      const deadline = Date.now() + (options.waitMs ?? 0);
      before = counter();
      while (before > 0 && Date.now() < deadline) {
        await this.sleep(this.pollMs);
        before = counter();
      }
      if (before > 0 && !options.force) {
        throw new BackupError(
          'agents_busy',
          `${before} agent container(s) are still running; retry later or force a best-effort backup`,
        );
      }
    }

    const key = options.key ?? generateKey();
    const id = newBackupId();
    fs.mkdirSync(this.options.backupsDir, { recursive: true, mode: 0o700 });
    const file = this.bundlePath(id);
    // The manifest records the state at the start; the sidecar below can only downgrade it.
    const consistencyAtStart: BundleManifest['consistency'] = options.hostStopped
      ? 'cold'
      : counter && before === 0
        ? 'quiescent'
        : 'best-effort';
    let changed = 0;
    const manifest = await createBundle({
      host,
      key,
      destFile: file,
      id,
      includeMachineIdentity: options.includeMachineIdentity,
      consistency: consistencyAtStart,
      onProgress: options.onProgress,
      onChanged: () => {
        changed += 1;
      },
    });
    // Agents that started while the snapshot ran, or files that changed under it, make the result best-effort.
    const agentsNow = counter ? counter() : 0;
    const consistency = !options.hostStopped && (agentsNow > 0 || changed > 0) ? 'best-effort' : manifest.consistency;
    const record = this.toRecord(manifest, fs.statSync(file).size, consistency, options.trigger ?? 'manual');
    fs.writeFileSync(this.metaPath(id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { record, key: formatKey(key) };
  }

  private toRecord(
    manifest: BundleManifest,
    bytes: number,
    consistency: BundleManifest['consistency'],
    trigger: 'manual' | 'scheduled',
  ): BackupRecord {
    return {
      id: manifest.id,
      createdAt: manifest.createdAt,
      bytes,
      release: manifest.source.version,
      commit: manifest.source.commit,
      consistency,
      entries: manifest.contents.entries,
      files: manifest.contents.files,
      contentBytes: manifest.contents.bytes,
      machineIdentity: manifest.identities.machineIdentityIncluded,
      trigger,
    };
  }

  list(): BackupRecord[] {
    if (!fs.existsSync(this.options.backupsDir)) return [];
    const records: BackupRecord[] = [];
    for (const name of fs.readdirSync(this.options.backupsDir)) {
      if (!name.endsWith('.meta.json')) continue;
      const id = name.slice(0, -'.meta.json'.length);
      if (!ID_PATTERN.test(id) || !fs.existsSync(this.bundlePath(id))) continue;
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(this.options.backupsDir, name), 'utf8')) as BackupRecord);
      } catch (error) {
        // A damaged sidecar only hides the entry from the list; the bundle itself is untouched.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): BackupRecord {
    const record = this.list().find((entry) => entry.id === id);
    if (!record) throw new BackupError('not_found', 'no such backup');
    return record;
  }

  fileFor(id: string): string {
    this.get(id);
    return this.bundlePath(id);
  }

  async verify(id: string, keyText: string): Promise<VerifyResult> {
    return verifyBundle(this.fileFor(id), parseKey(keyText));
  }

  delete(id: string): void {
    const file = this.fileFor(id);
    fs.rmSync(file);
    fs.rmSync(this.metaPath(id), { force: true });
  }

  /** Keep the newest `keep` scheduled backups and delete older scheduled ones. Manual backups are never touched. */
  pruneScheduled(keep: number): string[] {
    if (!Number.isInteger(keep) || keep < 1)
      throw new BackupError('invalid_id', 'keep must be a positive whole number');
    const scheduled = this.list().filter((record) => record.trigger === 'scheduled');
    const removed: string[] = [];
    for (const record of scheduled.slice(keep)) {
      this.delete(record.id);
      removed.push(record.id);
    }
    return removed;
  }

  /** Keep the newest `keepLast`, plus the newest of each of the `keepMonthly` most recent older months. */
  prune(policy: RetentionPolicy): string[] {
    if (!Number.isInteger(policy.keepLast) || policy.keepLast < 1)
      throw new BackupError('invalid_id', 'keepLast must be a whole number of 1 or more');
    if (!Number.isInteger(policy.keepMonthly) || policy.keepMonthly < 0)
      throw new BackupError('invalid_id', 'keepMonthly must be a whole number of 0 or more');
    const records = this.list();
    const keep = new Set(records.slice(0, policy.keepLast).map((record) => record.id));
    const months = new Set<string>();
    for (const record of records.slice(policy.keepLast)) {
      const month = record.createdAt.slice(0, 7);
      if (months.has(month) || months.size >= policy.keepMonthly) continue;
      months.add(month);
      keep.add(record.id);
    }
    const removed: string[] = [];
    for (const record of records) {
      if (keep.has(record.id)) continue;
      this.delete(record.id);
      removed.push(record.id);
    }
    return removed;
  }
}
