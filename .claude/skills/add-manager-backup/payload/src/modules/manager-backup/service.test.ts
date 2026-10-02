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
