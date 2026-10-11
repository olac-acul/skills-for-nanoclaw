/**
 * A backup runs in the background while the browser follows its progress. A backup of several gigabytes
 * takes minutes, far longer than one request should stay open, and the page needs something better to show
 * than a single sentence.
 *
 * One backup at a time. It waits up to a set time for agents to finish their current message (so the copy is
 * consistent), then goes ahead whether or not they did; the result records which it was (`quiescent` or
 * `best-effort`). The key belongs to the session that started the backup: it is handed over exactly once, to
 * that session, and never to another one. It is not kept after that or beyond a few minutes.
 */
import type { BackupRecord } from '../manager-backup/service.js';
import type { BackupPort } from './backend.js';

export type JobPhase = 'waiting' | 'snapshot' | 'pack';

export type JobStatus =
  | { state: 'idle' }
  | {
      state: 'running';
      phase: JobPhase;
      started_at: string;
      elapsed_seconds: number;
      wait_seconds: number;
      entries: number;
      bytes: number;
    }
  | { state: 'done'; started_at: string; finished_at: string; backup: BackupRecord; key: string | null }
  | { state: 'error'; started_at: string; error: string };

export class BackupJobError extends Error {
  constructor(readonly code: 'backup_key_pending') {
    super(code);
  }
}

interface Job {
  /** The session that started the backup and is the only one that may receive its key. */
  owner: string;
  startedAt: number;
  phase: JobPhase;
  entries: number;
  bytes: number;
  finishedAt?: number;
  record?: BackupRecord;
  key?: string | null;
  error?: string;
}

export interface BackupJobOptions {
  /** How long to wait for agents that are mid-message before going ahead anyway. */
  waitMs: number;
  /** How long a finished backup's key stays available for the first status request. */
  keyTtlMs?: number;
  now?: () => number;
  /** Receives the real error behind a failed backup; the browser only gets a code. */
  onError?: (error: unknown) => void;
}

const KNOWN_CODE = /^[a-z][a-z0-9_]{1,63}$/;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && KNOWN_CODE.test(code) ? code : 'internal_error';
}

export class BackupJobs {
  private job: Job | null = null;

  constructor(
    private readonly port: BackupPort,
    private readonly options: BackupJobOptions,
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private iso(at: number): string {
    return new Date(at).toISOString();
  }

  /** Start a backup for a session, or report the one already running. */
  start(owner: string): JobStatus {
    const previous = this.job;
    if (previous && previous.finishedAt === undefined) return this.status(owner);
    // Another session's key still waiting to be collected must not be thrown away by starting over.
    if (previous && previous.owner !== owner && this.keyWaiting(previous))
      throw new BackupJobError('backup_key_pending');
    const job: Job = { owner, startedAt: this.now(), phase: 'waiting', entries: 0, bytes: 0 };
    this.job = job;
    this.port
      .create({
        waitMs: this.options.waitMs,
        force: true,
        onProgress: (progress) => {
          job.phase = progress.phase;
          job.entries = progress.entries;
          job.bytes = progress.bytes;
        },
      })
      .then(
        ({ record, key }) => {
          job.record = record;
          job.key = key;
          job.finishedAt = this.now();
        },
        (error: unknown) => {
          this.options.onError?.(error);
          job.error = errorCode(error);
          job.finishedAt = this.now();
        },
      );
    return this.status(owner);
  }

  private keyWaiting(job: Job): boolean {
    return (
      job.finishedAt !== undefined &&
      Boolean(job.key) &&
      this.now() - job.finishedAt <= (this.options.keyTtlMs ?? 15 * 60_000)
    );
  }

  /** Where the backup stands. The starting session gets a finished backup's key once; everyone else never. */
  status(session: string): JobStatus {
    const job = this.job;
    if (!job) return { state: 'idle' };
    const started_at = this.iso(job.startedAt);
    if (job.finishedAt === undefined) {
      return {
        state: 'running',
        phase: job.phase,
        started_at,
        elapsed_seconds: Math.max(0, Math.round((this.now() - job.startedAt) / 1000)),
        wait_seconds: Math.round(this.options.waitMs / 1000),
        entries: job.entries,
        bytes: job.bytes,
      };
    }
    if (job.error !== undefined) return { state: 'error', started_at, error: job.error };
    const expired = this.now() - job.finishedAt > (this.options.keyTtlMs ?? 15 * 60_000);
    const mine = session === job.owner;
    const key = expired || !mine ? null : (job.key ?? null);
    if (mine || expired) job.key = null;
    return { state: 'done', started_at, finished_at: this.iso(job.finishedAt), backup: job.record!, key };
  }
}
