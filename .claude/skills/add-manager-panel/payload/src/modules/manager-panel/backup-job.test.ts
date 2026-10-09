import { describe, expect, it } from 'vitest';

import type { BackupRecord } from '../manager-backup/service.js';
import { BackupJobs } from './backup-job.js';
import type { BackupPort } from './backend.js';

const RECORD: BackupRecord = {
  id: '20261002T120000Z-abcdef',
  createdAt: '2026-10-02T12:00:00.000Z',
  bytes: 1234,
  release: '2.4.0',
  commit: 'a'.repeat(40),
  consistency: 'best-effort',
  entries: 10,
  files: 5,
  contentBytes: 999,
  machineIdentity: false,
};
const KEY = 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee-ffffffff-00000000-11111111';

interface Deferred {
  resolve(): void;
  reject(error: unknown): void;
  promise: Promise<void>;
}
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

/** A backup port whose create() runs until the test lets it finish, reporting progress on the way. */
function port(gate: Deferred) {
  const calls: Array<{ waitMs?: number; force?: boolean }> = [];
  let progress: ((p: { phase: 'snapshot' | 'pack'; entries: number; bytes: number }) => void) | undefined;
  const backups = {
    list: () => [],
    async create(options) {
      calls.push({ waitMs: options.waitMs, force: options.force });
      progress = options.onProgress;
      await gate.promise;
      return { record: RECORD, key: KEY };
    },
    verify: async () => ({}) as never,
    delete: () => undefined,
    fileFor: () => '/unused',
  } satisfies BackupPort;
  return { backups, calls, report: (p: Parameters<NonNullable<typeof progress>>[0]) => progress?.(p) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('BackupJobs', () => {
  it('starts as idle', () => {
    const gate = deferred();
    expect(new BackupJobs(port(gate).backups, { waitMs: 60_000 }).status()).toEqual({ state: 'idle' });
  });

  it('goes ahead with a best-effort backup after waiting, and follows the phases', async () => {
    const gate = deferred();
    const p = port(gate);
    let clock = 1_000_000;
    const jobs = new BackupJobs(p.backups, { waitMs: 60_000, now: () => clock });

    const first = jobs.start();
    expect(first).toMatchObject({ state: 'running', phase: 'waiting', wait_seconds: 60, entries: 0 });
    // It never refuses because agents are busy: the force flag is always set, and the wait is the configured one.
    expect(p.calls).toEqual([{ waitMs: 60_000, force: true }]);

    p.report({ phase: 'snapshot', entries: 0, bytes: 0 });
    clock += 5_000;
    expect(jobs.status()).toMatchObject({ phase: 'snapshot', elapsed_seconds: 5 });
    p.report({ phase: 'pack', entries: 120, bytes: 4096 });
    expect(jobs.status()).toMatchObject({ phase: 'pack', entries: 120, bytes: 4096 });

    gate.resolve();
    await tick();
    const done = jobs.status();
    expect(done).toMatchObject({ state: 'done', key: KEY });
    expect((done as { backup: BackupRecord }).backup.consistency).toBe('best-effort');
  });

  it('hands the key over once and never again', async () => {
    const gate = deferred();
    const jobs = new BackupJobs(port(gate).backups, { waitMs: 0 });
    jobs.start();
    gate.resolve();
    await tick();
    expect((jobs.status() as { key: string | null }).key).toBe(KEY);
    expect((jobs.status() as { key: string | null }).key).toBeNull();
    expect(jobs.status()).toMatchObject({ state: 'done', key: null });
  });

  it('drops a key nobody collected within the time limit', async () => {
    const gate = deferred();
    let clock = 0;
    const jobs = new BackupJobs(port(gate).backups, { waitMs: 0, keyTtlMs: 60_000, now: () => clock });
    jobs.start();
    gate.resolve();
    await tick();
    clock += 61_000;
    expect(jobs.status()).toMatchObject({ state: 'done', key: null });
  });

  it('runs one backup at a time: a second start reports the one in progress', async () => {
    const gate = deferred();
    const p = port(gate);
    const jobs = new BackupJobs(p.backups, { waitMs: 0 });
    jobs.start();
    expect(jobs.start()).toMatchObject({ state: 'running' });
    expect(p.calls).toHaveLength(1);
    gate.resolve();
    await tick();
    // After it finished, a new one may start.
    jobs.status();
    const again = deferred();
    const second = port(again);
    const next = new BackupJobs(second.backups, { waitMs: 0 });
    expect(next.start()).toMatchObject({ state: 'running' });
  });

  it('reports a failure as a code only, and passes the real error to the logger', async () => {
    const gate = deferred();
    const seen: unknown[] = [];
    const backups = {
      ...port(gate).backups,
      async create() {
        await gate.promise;
        throw Object.assign(new Error('secret detail: /home/someone/path'), { code: 'not_found' });
      },
    } satisfies BackupPort;
    const jobs = new BackupJobs(backups, { waitMs: 0, onError: (error) => seen.push(error) });
    jobs.start();
    gate.resolve();
    await tick();
    const status = jobs.status();
    expect(status).toMatchObject({ state: 'error', error: 'not_found' });
    expect(JSON.stringify(status)).not.toContain('secret detail');
    expect(seen).toHaveLength(1);
  });

  it('turns anything without a plain code into internal_error', async () => {
    const gate = deferred();
    const backups = {
      ...port(gate).backups,
      async create() {
        await gate.promise;
        throw Object.assign(new Error('boom'), { code: 'ENOSPC: /var/x' });
      },
    } satisfies BackupPort;
    const jobs = new BackupJobs(backups, { waitMs: 0 });
    jobs.start();
    gate.resolve();
    await tick();
    expect(jobs.status()).toMatchObject({ state: 'error', error: 'internal_error' });
  });

  it('allows a new backup after a failed one', async () => {
    const failing = deferred();
    let attempt = 0;
    const backups = {
      ...port(failing).backups,
      async create() {
        attempt += 1;
        if (attempt === 1) throw new Error('first fails');
        return { record: RECORD, key: KEY };
      },
    } satisfies BackupPort;
    const jobs = new BackupJobs(backups, { waitMs: 0 });
    jobs.start();
    await tick();
    expect(jobs.status()).toMatchObject({ state: 'error' });
    jobs.start();
    await tick();
    expect(jobs.status()).toMatchObject({ state: 'done', key: KEY });
  });
});
