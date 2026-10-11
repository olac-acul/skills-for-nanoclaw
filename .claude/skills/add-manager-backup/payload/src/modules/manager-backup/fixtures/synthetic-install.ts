/**
 * Synthetic NanoClaw installs for tests: real SQLite files, real directory
 * layout, obviously fake content. Test-only; never imported by production code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';

import { openBundleStream, snapshotSqliteFile, type BundleManifest } from '../bundle.js';
import { encryptStream } from '../crypto.js';
import type { BackupHost } from '../host.js';
import { packEntries, readTar, type PackItem } from '../tar.js';

export interface SyntheticOptions {
  /** Distinguishes two installs in the same test. */
  label: string;
  migrations?: string[];
  groups?: string[];
  /** Give group g1 a derived image tag and extra packages. */
  derivedImage?: boolean;
}

export interface SyntheticInstall {
  project: string;
  home: string;
  host: BackupHost;
  options: Required<SyntheticOptions>;
}

export function sqliteFile(file: string, statements: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  for (const statement of statements) db.exec(statement);
  db.close();
}

export function makeHost(
  project: string,
  home: string | null,
  registered: string[],
  overrides: Partial<BackupHost> = {},
): BackupHost {
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
    installedGateways: () => ['onecli'],
    registeredMigrations: () => registered,
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

export function createSyntheticInstall(root: string, input: SyntheticOptions): SyntheticInstall {
  const options: Required<SyntheticOptions> = {
    migrations: ['one', 'two'],
    groups: ['g1', 'g2'],
    derivedImage: false,
    ...input,
  };
  const project = path.join(root, `project-${options.label}`);
  const home = path.join(root, `home-${options.label}`);
  fs.mkdirSync(home, { recursive: true });

  const migrationRows = options.migrations.map((name, index) => `(${index + 1},'${name}','t')`).join(',');
  const groupRows = options.groups.map((id) => `('${id}','${options.label}-${id}')`).join(',');
  sqliteFile(path.join(project, 'data', 'v2.db'), [
    'CREATE TABLE schema_version (version INTEGER, name TEXT UNIQUE, applied TEXT)',
    `INSERT INTO schema_version VALUES ${migrationRows}`,
    'CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT)',
    `INSERT INTO agent_groups VALUES ${groupRows}`,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, container_status TEXT DEFAULT 'stopped')",
    "INSERT INTO sessions VALUES ('s1','running'),('s2','idle'),('s3','stopped')",
    'CREATE TABLE host_instances (instance_id TEXT PRIMARY KEY)',
    "INSERT INTO host_instances VALUES ('old-process')",
    'CREATE TABLE session_claims (session_id TEXT PRIMARY KEY, stop_intent TEXT)',
    "INSERT INTO session_claims VALUES ('s1','respawn_after_stop')",
    "CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, image_tag TEXT, packages_apt TEXT NOT NULL DEFAULT '[]', packages_npm TEXT NOT NULL DEFAULT '[]')",
    `INSERT INTO container_configs VALUES ('g1', ${options.derivedImage ? "'nanoclaw-agent:g1'" : 'NULL'}, ${options.derivedImage ? `'["ffmpeg"]'` : "'[]'"}, '[]')`,
    "INSERT INTO container_configs VALUES ('g2', NULL, '[]', '[]')",
  ]);

  const session = path.join(project, 'data', 'v2-sessions', 'g1', 's1');
  sqliteFile(path.join(session, 'inbound.db'), [
    "CREATE TABLE messages_in (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT DEFAULT 'pending', content TEXT NOT NULL)",
    `INSERT INTO messages_in VALUES ('m1','task','pending','${options.label}-task'),('m2','chat','pending','${options.label}-chat'),('m3','chat','completed','old')`,
  ]);
  sqliteFile(path.join(session, 'outbound.db'), [
    'CREATE TABLE messages_out (id INTEGER PRIMARY KEY, body TEXT)',
    `INSERT INTO messages_out(body) VALUES ('${options.label}-reply')`,
  ]);
  fs.mkdirSync(path.join(session, 'inbox'));
  fs.writeFileSync(path.join(session, 'inbox', 'attachment.txt'), `${options.label}-attachment`);
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
  fs.writeFileSync(
    path.join(project, 'data', 'upgrade-state.json'),
    JSON.stringify({ version: '2.4.0', commit: options.label }),
  );
  fs.writeFileSync(path.join(project, 'data', 'photon-auth.json'), `{"channel":"${options.label}"}`);

  fs.mkdirSync(path.join(project, 'groups', 'g1'), { recursive: true });
  fs.writeFileSync(path.join(project, 'groups', 'g1', 'CLAUDE.local.md'), `${options.label}-memory`);
  fs.mkdirSync(path.join(project, 'store', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(project, 'store', 'auth', 'creds.json'), `{"synthetic":"${options.label}"}`);
  fs.writeFileSync(
    path.join(project, '.env'),
    [
      `NANOCLAW_NAME=${options.label}`,
      `ONECLI_URL=http://${options.label}-gateway.test:10254`,
      `NANOCLAW_GATEWAY_PROVIDER=gw-${options.label}`,
      'OPENCODE_MODEL=openai/test',
      'OPENCODE_API_TOKEN=synthetic',
      'TELEGRAM_BOT_TOKEN=synthetic',
      'SIGNAL_ACCOUNT=+10000000000',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(home, 'mount-allowlist.json'), `{"label":"${options.label}"}`);
  fs.writeFileSync(path.join(home, 'device-key.json'), `${options.label}-device-key`);

  return { project, home, host: makeHost(project, home, options.migrations), options };
}

/** Encrypt raw tar bytes the way a bundle is written, optionally padding the gzip stream with trailing zeros. */
export async function sealTar(
  tar: Buffer,
  key: Buffer,
  destFile: string,
  options: { chunkLog2?: number; trailing?: number } = {},
): Promise<void> {
  const gz = zlib.gzipSync(tar);
  const plain = options.trailing ? Buffer.concat([gz, Buffer.alloc(options.trailing)]) : gz;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  await pipeline(
    Readable.from(encryptStream(Readable.from([plain]), key, { chunkLog2: options.chunkLog2 })),
    fs.createWriteStream(destFile),
  );
}

/**
 * Re-pack a bundle after changing its member list, to make hostile or odd archives out of a real
 * one. The manifest's counts are recomputed unless `recount` is false.
 */
export async function rewriteBundle(
  file: string,
  key: Buffer,
  destFile: string,
  edit: (items: PackItem[]) => PackItem[],
  options: { recount?: boolean; manifest?: (manifest: BundleManifest) => void } = {},
): Promise<void> {
  const items: PackItem[] = [];
  for await (const entry of readTar(openBundleStream(file, key))) {
    const parts: Buffer[] = [];
    for await (const part of entry.body) parts.push(part);
    items.push({ meta: { ...entry.meta }, content: entry.meta.type === 'file' ? Buffer.concat(parts) : undefined });
  }
  const manifest = JSON.parse(items[0].content!.toString('utf8')) as BundleManifest;
  const rest = edit(items.slice(1));
  options.manifest?.(manifest);
  if (options.recount !== false) {
    const files = rest.filter((item) => item.meta.type === 'file');
    manifest.contents = {
      entries: rest.length + 1,
      files: files.length + 1,
      bytes: files.reduce((sum, item) => sum + item.meta.size, 0),
    };
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const all: PackItem[] = [{ meta: { ...items[0].meta, size: manifestBytes.length }, content: manifestBytes }, ...rest];
  const tar = Buffer.concat(await collectTar(packEntries(all)));
  await sealTar(tar, key, destFile);
}

async function collectTar(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return parts;
}

/** A regular-file item with in-memory content, for hand-made archives. */
export function fileEntry(archivePath: string, content: string | Buffer): PackItem {
  const buf = Buffer.from(content);
  return {
    meta: { path: archivePath, type: 'file', mode: 0o600, uid: 0, gid: 0, mtime: 1_700_000_000, size: buf.length },
    content: buf,
  };
}

/** A symlink item for hand-made archives. */
export function linkEntry(archivePath: string, target: string): PackItem {
  return {
    meta: {
      path: archivePath,
      type: 'symlink',
      mode: 0o777,
      uid: 0,
      gid: 0,
      mtime: 1_700_000_000,
      size: 0,
      linkpath: target,
    },
  };
}
