import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readManifest } from './bundle.js';
import { CryptoError, parseKey } from './crypto.js';
import { createSyntheticInstall, type SyntheticInstall } from './fixtures/synthetic-install.js';
import { BackupError, BackupService } from './service.js';

let tmp: string;
let install: SyntheticInstall;

function service(counter?: () => number, extra: { sleep?: (ms: number) => Promise<void> } = {}): BackupService {
  return new BackupService({
    host: { ...install.host, busyAgentCount: counter },
    backupsDir: path.join(tmp, 'backups'),
    sleep: extra.sleep ?? (async () => undefined),
    pollMs: 1,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-service-'));
  install = createSyntheticInstall(tmp, { label: 'svc' });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('create', () => {
  it('returns a key once, stores nothing secret next to the bundle, and lists the backup', async () => {
    const svc = service();
    const { record, key } = await svc.create({ hostStopped: true });
    expect(key).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    expect(record.consistency).toBe('cold');

    const dir = path.join(tmp, 'backups');
    expect(fs.readdirSync(dir).sort()).toEqual([`${record.id}.mbk`, `${record.id}.meta.json`]);
    for (const name of fs.readdirSync(dir))
      expect(fs.readFileSync(path.join(dir, name)).includes(key.replace(/-/g, ''))).toBe(false);
    expect(fs.readFileSync(path.join(dir, `${record.id}.meta.json`), 'utf8')).not.toContain('svc-g1'); // no group names in the sidecar

    expect(svc.list().map((entry) => entry.id)).toEqual([record.id]);
    expect(svc.get(record.id).files).toBe(record.files);
    expect((await readManifest(svc.fileFor(record.id), parseKey(key))).id).toBe(record.id);
  });

  it('waits for agents to finish, then records a quiescent backup', async () => {
    let running = 2;
    const svc = service(() => running, {
      sleep: async () => {
        running = Math.max(0, running - 1);
      },
    });
    const { record } = await svc.create({ waitMs: 10_000 });
    expect(running).toBe(0);
    expect(record.consistency).toBe('quiescent');
  });

  it('refuses when agents are still running after the wait, unless forced', async () => {
    const svc = service(() => 1);
    await expect(svc.create({ waitMs: 5 })).rejects.toMatchObject({ code: 'agents_busy' });
    expect(svc.list()).toEqual([]);
    const { record } = await svc.create({ waitMs: 5, force: true });
    expect(record.consistency).toBe('best-effort');
  });
});

describe('verify / delete / prune', () => {
  it('verifies with the right key and rejects the wrong one', async () => {
    const svc = service();
    const { record, key } = await svc.create({ hostStopped: true });
    expect((await svc.verify(record.id, key)).manifest.id).toBe(record.id);
    await expect(svc.verify(record.id, '0'.repeat(64))).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects malformed or unknown ids without touching the filesystem outside the backup directory', async () => {
    const svc = service();
    expect(() => svc.fileFor('../../etc/passwd')).toThrow(BackupError);
    expect(() => svc.delete('20260101T000000Z-aaaaaa')).toThrow(BackupError);
  });

  it('deletes both files', async () => {
    const svc = service();
    const { record } = await svc.create({ hostStopped: true });
    svc.delete(record.id);
    expect(fs.readdirSync(path.join(tmp, 'backups'))).toEqual([]);
  });

  it('keeps the newest N plus one per older month', () => {
    const dir = path.join(tmp, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dates = ['20260901', '20260902', '20260903', '20260810', '20260805', '20260710', '20260601'];
    const svc = service();
    for (const [index, date] of dates.entries()) {
      const id = `${date}T120000Z-00000${index}`;
      fs.writeFileSync(path.join(dir, `${id}.mbk`), 'x');
      const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00.000Z`;
      fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, createdAt: iso }));
    }
    const removed = svc.prune({ keepLast: 2, keepMonthly: 2 });
    // kept: 0903, 0902 (last 2) + newest of the next two months present: 0901 (Sep) is the newest remaining in Sep, then Aug 0810
    expect(removed.sort()).toEqual(['20260601T120000Z-000006', '20260710T120000Z-000005', '20260805T120000Z-000004']);
    expect(svc.list().map((entry) => entry.id.slice(0, 8))).toEqual(['20260903', '20260902', '20260901', '20260810']);
  });
});

describe('prune validation', () => {
  it('refuses a policy that would keep nothing or is not a whole number', () => {
    const svc = service();
    for (const keepLast of [0, -1, 1.5, Number.NaN]) {
      expect(() => svc.prune({ keepLast, keepMonthly: 1 })).toThrow(BackupError);
    }
    for (const keepMonthly of [-1, 0.5, Number.NaN]) {
      expect(() => svc.prune({ keepLast: 1, keepMonthly })).toThrow(BackupError);
    }
    expect(svc.prune({ keepLast: 1, keepMonthly: 0 })).toEqual([]);
  });
});

describe('scheduled backups', () => {
  it('uses the key it is given, records who started it, and a manual backup is recorded as manual', async () => {
    const svc = service();
    const { generateKey, formatKey } = await import('./crypto.js');
    const key = generateKey();
    const scheduled = await svc.create({ hostStopped: true, key, trigger: 'scheduled' });
    expect(scheduled.key).toBe(formatKey(key));
    expect(scheduled.record.trigger).toBe('scheduled');
    expect((await readManifest(svc.fileFor(scheduled.record.id), key)).id).toBe(scheduled.record.id);
    const manual = await svc.create({ hostStopped: true });
    expect(manual.record.trigger).toBe('manual');
    expect(svc.list().map((entry) => entry.trigger)).toEqual(['manual', 'scheduled']);
  });

  it('keeps the newest scheduled backups and never touches manual ones', async () => {
    const svc = service();
    const { generateKey } = await import('./crypto.js');
    const key = generateKey();
    const made: string[] = [];
    for (let index = 0; index < 4; index++) {
      made.push((await svc.create({ hostStopped: true, key, trigger: 'scheduled' })).record.id);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // ids carry the second
    }
    const manual = (await svc.create({ hostStopped: true })).record.id;
    expect(svc.pruneScheduled(2)).toEqual([made[1], made[0]]);
    const left = svc.list().map((entry) => entry.id);
    expect(left).toContain(manual);
    expect(left).toContain(made[3]);
    expect(left).toContain(made[2]);
    expect(left).not.toContain(made[0]);
    expect(left).toHaveLength(3);
    expect(svc.pruneScheduled(2)).toEqual([]);
  }, 30_000);

  it('treats a backup whose sidecar has no trigger as manual', async () => {
    const svc = service();
    const { record } = await svc.create({ hostStopped: true });
    const meta = path.join(tmp, 'backups', `${record.id}.meta.json`);
    const stored = JSON.parse(fs.readFileSync(meta, 'utf8'));
    delete stored.trigger;
    fs.writeFileSync(meta, JSON.stringify(stored));
    expect(svc.pruneScheduled(1)).toEqual([]);
    expect(svc.list()).toHaveLength(1);
  });

  it('refuses a keep value that is not a positive whole number', () => {
    const svc = service();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => svc.pruneScheduled(bad)).toThrow(BackupError);
  });
});
