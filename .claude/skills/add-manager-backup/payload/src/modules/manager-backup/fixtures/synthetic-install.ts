/**
 * Synthetic NanoClaw installs for tests: real SQLite files, real directory
 * layout, obviously fake content. Test-only; never imported by production code.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { snapshotSqliteFile } from '../bundle.js';
import type { BackupHost } from '../host.js';

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
