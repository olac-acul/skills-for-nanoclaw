import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUNDLE_POLICY,
  BundleError,
  MACHINE_IDENTITY_FILES,
  createBundle,
  readManifest,
  snapshotSqliteFile,
  verifyBundle,
} from './bundle.js';
import { CryptoError, generateKey } from './crypto.js';
import type { BackupHost } from './host.js';
import { extractTar } from './tar.js';
import { openBundleStream } from './bundle.js';

let tmp: string;
let project: string;
let home: string;

function sqlite(file: string, statements: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  for (const statement of statements) db.exec(statement);
  db.close();
}

function makeHost(overrides: Partial<BackupHost> = {}): BackupHost {
  const dataDir = path.join(project, 'data');
  return {
    projectRoot: project,
    dataDir,
    groupsDir: path.join(project, 'groups'),
    storeDir: path.join(project, 'store'),
    envFile: path.join(project, '.env'),
    homeConfigDir: home,
    identity: () => ({ version: '2.4.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40) }),
    installSlug: () => 'test-slug',
    installed: () => ({
      channels: ['telegram'],
      providers: ['opencode'],
      containerProviders: ['opencode'],
      modules: ['approvals'],
      gateway: 'onecli',
      driver: 'docker',
    }),
    registeredMigrations: () => ['one', 'two'],
    describeDb: async () => {
      const db = new Database(path.join(dataDir, 'v2.db'), { readonly: true });
      try {
        const migrations = (
          db.prepare('SELECT name FROM schema_version ORDER BY name').all() as Array<{ name: string }>
        ).map((row) => row.name);
        const counts = { agent_groups: (db.prepare('SELECT COUNT(*) c FROM agent_groups').get() as { c: number }).c };
        return { dialect: 'sqlite', migrations, counts };
      } finally {
        db.close();
      }
    },
    snapshotCentralDb: async (dest) => snapshotSqliteFile(path.join(dataDir, 'v2.db'), dest),
    ...overrides,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-bundle-'));
  project = path.join(tmp, 'project');
  home = path.join(tmp, 'home-config');
  fs.mkdirSync(home, { recursive: true });

  sqlite(path.join(project, 'data', 'v2.db'), [
    'CREATE TABLE schema_version (version INTEGER, name TEXT UNIQUE, applied TEXT)',
    "INSERT INTO schema_version VALUES (1,'one','t'),(2,'two','t')",
    'CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT)',
    "INSERT INTO agent_groups VALUES ('g1','Alpha'),('g2','Beta')",
  ]);
  const session = path.join(project, 'data', 'v2-sessions', 'g1', 's1');
  sqlite(path.join(session, 'inbound.db'), [
    'CREATE TABLE messages_in (id INTEGER PRIMARY KEY, body TEXT)',
    "INSERT INTO messages_in(body) VALUES ('hello')",
  ]);
  sqlite(path.join(session, 'outbound.db'), [
    'CREATE TABLE messages_out (id INTEGER PRIMARY KEY, body TEXT)',
    "INSERT INTO messages_out(body) VALUES ('reply')",
  ]);
  fs.mkdirSync(path.join(session, 'inbox'));
  fs.writeFileSync(path.join(session, 'inbox', 'attachment.txt'), 'attached');
  fs.writeFileSync(path.join(session, '.heartbeat'), '');
  fs.mkdirSync(path.join(project, 'data', 'v2-sessions', 'g1', '.context'));
  fs.writeFileSync(path.join(project, 'data', 'v2-sessions', 'g1', '.context', 's1.json'), '{}');
  fs.mkdirSync(path.join(project, 'data', 'v2-sessions', 'g1', '.claude-shared', 'skills'), { recursive: true });
  fs.symlinkSync(
    '/app/skills/welcome',
    path.join(project, 'data', 'v2-sessions', 'g1', '.claude-shared', 'skills', 'welcome'),
  );
  fs.writeFileSync(path.join(project, 'data', 'circuit-breaker.json'), '{}');
  fs.writeFileSync(path.join(project, 'data', 'Dockerfile.g1'), 'FROM x');
  fs.writeFileSync(path.join(project, 'data', 'upgrade-state.json'), '{"version":"2.4.0"}');

  fs.mkdirSync(path.join(project, 'groups', 'g1'), { recursive: true });
  fs.writeFileSync(path.join(project, 'groups', 'g1', 'CLAUDE.local.md'), 'memory');
  fs.mkdirSync(path.join(project, 'store', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(project, 'store', 'auth', 'creds.json'), '{"synthetic":true}');
  fs.writeFileSync(path.join(project, '.env'), 'EXAMPLE_SETTING=1\n');

  fs.writeFileSync(path.join(home, 'mount-allowlist.json'), '{"roots":[]}');
  for (const name of MACHINE_IDENTITY_FILES) fs.writeFileSync(path.join(home, name), 'synthetic');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function makeBundle(host = makeHost(), extra: { includeMachineIdentity?: boolean; key?: Buffer } = {}) {
  const key = extra.key ?? generateKey();
  const destFile = path.join(tmp, 'out', 'b.mbk');
  const manifest = await createBundle({ host, key, destFile, includeMachineIdentity: extra.includeMachineIdentity });
  return { key, destFile, manifest };
}

async function extractAll(file: string, key: Buffer): Promise<string> {
  const dest = path.join(tmp, `restored-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dest);
  await extractTar(openBundleStream(file, key), dest, { policy: BUNDLE_POLICY });
  return dest;
}

describe('createBundle', () => {
  it('writes an encrypted bundle and a descriptive manifest', async () => {
    const { destFile, manifest, key } = await makeBundle();
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.existsSync(`${destFile}.partial`)).toBe(false);
    expect(fs.statSync(destFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(destFile).includes('Alpha')).toBe(false); // nothing readable at rest

    expect(manifest.schema).toBe('manager-backup/v1');
    expect(manifest.db.migrations).toEqual(['one', 'two']);
    expect(manifest.db.counts).toEqual({ agent_groups: 2 });
    expect(manifest.installed.gateway).toBe('onecli');
    expect(manifest.identities.machineIdentityIncluded).toBe(false);
    expect(await readManifest(destFile, key)).toEqual(manifest);
  });

  it('contains the central snapshot, session databases, files and settings', async () => {
    const { destFile, key } = await makeBundle();
    const out = await extractAll(destFile, key);

    const central = new Database(path.join(out, 'db', 'v2.db'), { readonly: true });
    expect(central.prepare('SELECT COUNT(*) c FROM agent_groups').get()).toEqual({ c: 2 });
    central.close();

    const session = path.join(out, 'data', 'v2-sessions', 'g1', 's1');
    const inbound = new Database(path.join(session, 'inbound.db'), { readonly: true });
    expect(inbound.prepare('SELECT body FROM messages_in').get()).toEqual({ body: 'hello' });
    inbound.close();
    expect(fs.readFileSync(path.join(session, 'inbox', 'attachment.txt'), 'utf8')).toBe('attached');
    expect(fs.readlinkSync(path.join(out, 'data', 'v2-sessions', 'g1', '.claude-shared', 'skills', 'welcome'))).toBe(
      '/app/skills/welcome',
    );
    expect(fs.readFileSync(path.join(out, 'data', 'upgrade-state.json'), 'utf8')).toContain('2.4.0');
    expect(fs.readFileSync(path.join(out, 'groups', 'g1', 'CLAUDE.local.md'), 'utf8')).toBe('memory');
    expect(fs.readFileSync(path.join(out, 'store', 'auth', 'creds.json'), 'utf8')).toContain('synthetic');
    expect(fs.readFileSync(path.join(out, 'env', 'dotenv'), 'utf8')).toBe('EXAMPLE_SETTING=1\n');
    expect(fs.existsSync(path.join(out, 'config', 'nanoclaw', 'mount-allowlist.json'))).toBe(true);
  });

  it('leaves out transient and machine-specific files', async () => {
    const socket = path.join(project, 'data', 'ncl.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const { destFile, key } = await makeBundle();
      const out = await extractAll(destFile, key);
      expect(fs.readdirSync(path.join(out, 'data')).sort()).toEqual(['upgrade-state.json', 'v2-sessions']);
      expect(fs.existsSync(path.join(out, 'data', 'v2-sessions', 'g1', 's1', '.heartbeat'))).toBe(false);
      expect(fs.existsSync(path.join(out, 'data', 'v2-sessions', 'g1', '.context'))).toBe(false);
      expect(fs.readdirSync(path.join(out, 'config', 'nanoclaw'))).toEqual(['mount-allowlist.json']);
    } finally {
      server.close();
    }
  });

  it('includes machine identity files only on request', async () => {
    const { destFile, key, manifest } = await makeBundle(makeHost(), { includeMachineIdentity: true });
    expect(manifest.identities.machineIdentityIncluded).toBe(true);
    const out = await extractAll(destFile, key);
    expect(fs.readdirSync(path.join(out, 'config', 'nanoclaw')).sort()).toEqual([
      'account.json',
      'device-key.json',
      'host-id',
      'mount-allowlist.json',
    ]);
  });

  it('follows a data directory that is a symlink to other storage', async () => {
    const elsewhere = path.join(tmp, 'external-data');
    fs.renameSync(path.join(project, 'data'), elsewhere);
    fs.symlinkSync(elsewhere, path.join(project, 'data'));
    const { destFile, key } = await makeBundle(
      makeHost({ snapshotCentralDb: async (dest) => snapshotSqliteFile(path.join(elsewhere, 'v2.db'), dest) }),
    );
    const out = await extractAll(destFile, key);
    expect(fs.existsSync(path.join(out, 'data', 'v2-sessions', 'g1', 's1', 'inbound.db'))).toBe(true);
  });

  it('fails without leaving a partial file when a source cannot be snapshotted', async () => {
    fs.writeFileSync(path.join(project, 'data', 'v2-sessions', 'g1', 's1', 'outbound.db'), 'not a database');
    const destFile = path.join(tmp, 'out', 'b.mbk');
    await expect(createBundle({ host: makeHost(), key: generateKey(), destFile })).rejects.toBeInstanceOf(BundleError);
    expect(fs.existsSync(destFile)).toBe(false);
    expect(fs.existsSync(`${destFile}.partial`)).toBe(false);
  });
});

describe('workspace links', () => {
  it('keeps links that point outside the tree (a virtual environment) through backup, verify and restore, but not in data/', async () => {
    fs.mkdirSync(path.join(project, 'groups', 'g1', 'venv', 'bin'), { recursive: true });
    fs.symlinkSync('/usr/bin/python3', path.join(project, 'groups', 'g1', 'venv', 'bin', 'python'));
    fs.symlinkSync('../../shared', path.join(project, 'groups', 'g1', 'shared-link'));
    const { destFile, key } = await makeBundle();
    await verifyBundle(destFile, key);
    const out = await extractAll(destFile, key);
    expect(fs.readlinkSync(path.join(out, 'groups', 'g1', 'venv', 'bin', 'python'))).toBe('/usr/bin/python3');
    expect(fs.readlinkSync(path.join(out, 'groups', 'g1', 'shared-link'))).toBe('../../shared');
  });

  it('still refuses an escaping link inside data/', () => {
    expect(BUNDLE_POLICY.allowSymlink!('data/v2-sessions/g/link', '/etc/passwd')).toBe(false);
    expect(BUNDLE_POLICY.allowSymlink!('data/v2-sessions/g/link', '../../../outside')).toBe(false);
    expect(BUNDLE_POLICY.allowSymlink!('data/v2-sessions/g/skills/x', '/app/skills/x')).toBe(true);
    expect(BUNDLE_POLICY.allowSymlink!('groups/g/venv/python', '/usr/bin/python3')).toBe(true);
  });
});

describe('verifyBundle', () => {
  it('accepts an intact bundle and reports its size', async () => {
    const { destFile, key, manifest } = await makeBundle();
    const result = await verifyBundle(destFile, key);
    expect(result.manifest.id).toBe(manifest.id);
    expect(result.entries).toBe(manifest.contents.entries);
    expect(result.files).toBe(manifest.contents.files);
  });

  it('rejects the wrong key', async () => {
    const { destFile } = await makeBundle();
    await expect(verifyBundle(destFile, generateKey())).rejects.toBeInstanceOf(CryptoError);
    await expect(readManifest(destFile, generateKey())).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects a damaged bundle', async () => {
    const { destFile, key } = await makeBundle();
    const bytes = fs.readFileSync(destFile);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(destFile, bytes);
    await expect(verifyBundle(destFile, key)).rejects.toBeInstanceOf(CryptoError);
  });

  it('rejects a truncated bundle', async () => {
    const { destFile, key } = await makeBundle();
    const bytes = fs.readFileSync(destFile);
    fs.writeFileSync(destFile, bytes.subarray(0, bytes.length - 40));
    await expect(verifyBundle(destFile, key)).rejects.toBeInstanceOf(CryptoError);
  });
});
