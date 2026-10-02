/**
 * Integration with upstream: real migrations, real DbDriver, real barrels.
 * This is the test that goes red when upstream moves something the backup
 * module depends on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initDb } from '../../db/connection.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import type { DbDriver } from '../../db/driver.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession } from '../../db/sessions.js';
import { createBundle, verifyBundle } from './bundle.js';
import { generateKey } from './crypto.js';
import type { BackupHost } from './host.js';
import { restoreBundle } from './restore.js';
import Database from 'better-sqlite3';

import { countBusySessions, createUpstreamHost, readInventory } from './upstream-host.js';

let tmp: string;
let db: DbDriver;

function hostFor(project: string, home: string): BackupHost {
  return {
    // Identity and inventory come from the real checkout; only the data locations point at the scratch install.
    ...createUpstreamHost({ db, projectRoot: process.cwd() }),
    projectRoot: project,
    dataDir: path.join(project, 'data'),
    groupsDir: path.join(project, 'groups'),
    storeDir: path.join(project, 'store'),
    envFile: path.join(project, '.env'),
    homeConfigDir: home,
  };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-upstream-'));
  await closeDb();
  fs.mkdirSync(path.join(tmp, 'a', 'data'), { recursive: true });
  db = await initDb(path.join(tmp, 'a', 'data', 'v2.db'), { role: 'migration' });
  await runMigrations(db, undefined, { mode: 'migrate' });
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('against the real upstream schema', () => {
  it('describes the database from the real migration ledger', async () => {
    const host = hostFor(path.join(tmp, 'a'), path.join(tmp, 'home-a'));
    const description = await host.describeDb();
    expect(description.dialect).toBe('sqlite');
    expect(description.migrations.length).toBeGreaterThan(10);
    expect(description.migrations).toEqual(expect.arrayContaining(['container-configs', 'host-coordination']));
    expect(host.registeredMigrations()).toEqual(expect.arrayContaining(description.migrations));
    expect(host.identity().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('backs up and restores a real database, applying the fix-ups to the real tables', async () => {
    const projectA = path.join(tmp, 'a');
    const now = new Date().toISOString();
    await createAgentGroup({
      id: 'g1',
      name: 'Alpha',
      folder: 'alpha',
      agent_provider: null,
      created_at: now,
    } as never);
    await ensureContainerConfig('g1', 'opencode');
    await db.run(
      "UPDATE container_configs SET image_tag = 'nanoclaw-agent:g1', packages_apt = '[\"ffmpeg\"]' WHERE agent_group_id = 'g1'",
    );
    await createSession({
      id: 's1',
      agent_group_id: 'g1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    } as never);
    await db.run(
      "INSERT INTO host_instances (instance_id, install_id, started_at, lease_expires_at) VALUES ('old', 'x', ?, ?)",
      now,
      now,
    );
    await db.run(
      "INSERT INTO session_claims (session_id, incarnation, stop_intent, updated_at) VALUES ('s1', 1, 'respawn_after_stop', ?)",
      now,
    );
    fs.mkdirSync(path.join(projectA, 'groups', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(projectA, 'groups', 'alpha', 'CLAUDE.local.md'), 'memory');
    fs.writeFileSync(path.join(projectA, '.env'), 'NANOCLAW_NAME=a\n');

    const hostA = hostFor(projectA, path.join(tmp, 'home-a'));
    const key = generateKey();
    const bundleFile = path.join(tmp, 'b.mbk');
    const manifest = await createBundle({ host: hostA, key, destFile: bundleFile });
    expect(manifest.db.counts).toMatchObject({ agent_groups: 1, sessions: 1, container_configs: 1 });
    await verifyBundle(bundleFile, key);

    // Restore into a second, freshly migrated install.
    const projectB = path.join(tmp, 'b');
    fs.mkdirSync(path.join(projectB, 'data'), { recursive: true });
    const hostB = { ...hostFor(projectB, path.join(tmp, 'home-b')), describeDb: hostA.describeDb };
    const result = await restoreBundle({ host: hostB, bundleFile, key, mode: 'full', skipHostProbe: true });
    expect(result.rebuildGroups).toEqual(['g1']);

    // Open the restored file with the real driver and check what the host would see.
    await closeDb();
    const restored = await initDb(path.join(projectB, 'data', 'v2.db'), { role: 'tool' });
    expect(await restored.all('SELECT id, container_status FROM sessions')).toEqual([
      { id: 's1', container_status: 'stopped' },
    ]);
    expect(await restored.all('SELECT * FROM host_instances')).toEqual([]);
    expect(await restored.all('SELECT * FROM session_claims')).toEqual([]);
    expect(
      await restored.get('SELECT image_tag, provider FROM container_configs WHERE agent_group_id = ?', 'g1'),
    ).toEqual({
      image_tag: null,
      provider: 'opencode',
    });
    expect(fs.readFileSync(path.join(projectB, 'groups', 'alpha', 'CLAUDE.local.md'), 'utf8')).toBe('memory');
  });

  it('reads the installed-skill inventory from the real barrels', () => {
    const inventory = readInventory(process.cwd());
    expect(inventory.modules).toEqual(expect.arrayContaining(['approvals']));
    expect(inventory.channels).not.toContain('cli');
    expect(inventory.driver).toBeTruthy();
  });
});

describe('countBusySessions', () => {
  function mailbox(root: string, group: string, session: string, statuses: string[]): void {
    const dir = path.join(root, 'v2-sessions', group, session);
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'outbound.db'));
    db.exec('CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT)');
    statuses.forEach((status, index) =>
      db.prepare('INSERT INTO processing_ack VALUES (?, ?, ?)').run(`m${index}`, status, 't'),
    );
    db.close();
  }

  it('counts only sessions with a message being worked on', () => {
    const root = path.join(tmp, 'busy');
    mailbox(root, 'g1', 's1', ['completed', 'completed']); // idle container waiting for work
    mailbox(root, 'g1', 's2', ['completed', 'processing']); // mid-turn
    mailbox(root, 'g2', 's3', ['processing', 'processing']); // mid-turn (counted once)
    mailbox(root, 'g2', 's4', []);
    expect(countBusySessions(root)).toBe(2);
  });

  it('is zero without sessions and treats an unreadable mailbox as busy', () => {
    expect(countBusySessions(path.join(tmp, 'none'))).toBe(0);
    const root = path.join(tmp, 'broken');
    fs.mkdirSync(path.join(root, 'v2-sessions', 'g', 's'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v2-sessions', 'g', 's', 'outbound.db'), 'not a database');
    expect(countBusySessions(root)).toBe(1);
  });
});
