/**
 * The real `BackupHost`, backed by upstream NanoClaw internals.
 *
 * This is the only file in the module that imports upstream code (besides the
 * barrel wiring). When upstream renames or moves something, this is where the
 * compatibility build breaks and where the fix goes.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR, STORE_DIR } from '../../config.js';
import type { DbDriver } from '../../db/driver.js';
import { getRegisteredMigrations } from '../../db/migrations/index.js';
import { readEnvFile } from '../../env.js';
import { getInstallSlug } from '../../install-slug.js';
import { getCodeIdentity } from '../../upgrade-state.js';
import type { BackupHost, DbDescription, InstalledInventory } from './host.js';

const COUNTED_TABLES = ['agent_groups', 'messaging_groups', 'users', 'sessions', 'container_configs'];

/** Imports of the form `import './name.js'` (flat barrel) or `import './name/index.js'` (module barrel). */
function barrelImports(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const names: string[] = [];
  const re = /^\s*import\s+['"]\.\/([a-z0-9-]+)(?:\/index)?\.js['"];?\s*$/gm;
  for (const match of fs.readFileSync(file, 'utf8').matchAll(re)) names.push(match[1]);
  return names;
}

/** Gateways whose skill is installed: the imports of `src/gateway-providers/installed.ts`. */
export function readInstalledGateways(projectRoot: string): string[] {
  return barrelImports(path.join(projectRoot, 'src/gateway-providers/installed.ts')).sort();
}

/** Names of the secrets in the OneCLI gateway, or null when the CLI is missing or the gateway is down. */
export function listOneCliSecretNames(): Promise<string[] | null> {
  const home = process.env.HOME || os.homedir();
  const PATH = `${path.join(home, '.local', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
  return new Promise((resolve) => {
    execFile(
      'onecli',
      ['secrets', 'list'],
      { env: { ...process.env, PATH }, timeout: 8000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const data = (JSON.parse(stdout) as { data?: Array<{ name?: unknown }> }).data;
          resolve(
            Array.isArray(data)
              ? data.flatMap((entry) => (typeof entry.name === 'string' ? [entry.name] : [])).sort()
              : null,
          );
          // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable output simply means the names are unknown
        } catch {
          resolve(null);
        }
      },
    );
  });
}

export function readInventory(projectRoot: string): InstalledInventory {
  const channels = barrelImports(path.join(projectRoot, 'src/channels/index.ts')).filter((name) => name !== 'cli');
  const providers = barrelImports(path.join(projectRoot, 'src/providers/index.ts'));
  const containerProviders = barrelImports(
    path.join(projectRoot, 'container/agent-runner/src/providers/index.ts'),
  ).filter((name) => name !== 'claude');
  const modules = barrelImports(path.join(projectRoot, 'src/modules/index.ts'));
  const env = readEnvFile(['NANOCLAW_GATEWAY_PROVIDER', 'NANOCLAW_RUNTIME_DRIVER'], projectRoot);
  return {
    channels: channels.sort(),
    providers: providers.sort(),
    containerProviders: containerProviders.sort(),
    modules: modules.sort(),
    gateway: process.env.NANOCLAW_GATEWAY_PROVIDER?.trim() || env.NANOCLAW_GATEWAY_PROVIDER?.trim() || null,
    driver: process.env.NANOCLAW_RUNTIME_DRIVER?.trim() || env.NANOCLAW_RUNTIME_DRIVER?.trim() || 'docker',
  };
}

/**
 * Sessions whose agent is working on a message right now: the container has
 * claimed a message (`processing_ack.status = 'processing'`) and not finished
 * it. A container that is alive and waiting for the next message does not
 * count, which is what lets a backup run while agents sit idle.
 */
export function countBusySessions(dataDir: string): number {
  const sessionsDir = path.join(dataDir, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return 0;
  let busy = 0;
  for (const group of fs.readdirSync(sessionsDir)) {
    const groupDir = path.join(sessionsDir, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const session of fs.readdirSync(groupDir)) {
      const outbound = path.join(groupDir, session, 'outbound.db');
      if (!fs.existsSync(outbound)) continue;
      const db = new Database(outbound, { readonly: true });
      try {
        db.pragma('busy_timeout = 2000');
        const row = db.prepare("SELECT COUNT(*) AS c FROM processing_ack WHERE status = 'processing'").get() as {
          c: number;
        };
        if (row.c > 0) busy++;
        // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable mailbox must count as busy, whatever the cause
      } catch {
        // An unreadable or older-format mailbox is treated as busy: better to wait than to copy mid-write.
        busy++;
      } finally {
        db.close();
      }
    }
  }
  return busy;
}

export interface UpstreamHostOptions {
  db: DbDriver;
  /** Count of agents mid-turn; only meaningful inside the host process. */
  busyAgentCount?: () => number;
  projectRoot?: string;
}

export function createUpstreamHost(options: UpstreamHostOptions): BackupHost {
  const projectRoot = options.projectRoot ?? process.cwd();
  const { db } = options;
  const home = process.env.HOME || os.homedir();

  return {
    projectRoot,
    dataDir: DATA_DIR,
    groupsDir: GROUPS_DIR,
    storeDir: STORE_DIR,
    envFile: path.join(projectRoot, '.env'),
    homeConfigDir: path.join(home, '.config', 'nanoclaw'),
    identity: () => getCodeIdentity(projectRoot),
    installSlug: () => getInstallSlug(projectRoot),
    installed: () => readInventory(projectRoot),
    installedGateways: () => readInstalledGateways(projectRoot),
    gatewayCredentialNames: async () =>
      readInventory(projectRoot).gateway === 'onecli' ? listOneCliSecretNames() : null,
    registeredMigrations: () => getRegisteredMigrations().map((migration) => migration.name),
    busyAgentCount: options.busyAgentCount,
    async describeDb(): Promise<DbDescription> {
      const rows = await db.all<{ name: string }>('SELECT name FROM schema_version ORDER BY name');
      const counts: Record<string, number> = {};
      for (const table of COUNTED_TABLES) {
        if (!(await db.hasTable(table))) continue;
        const row = await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
        counts[table] = Number(row?.c ?? 0);
      }
      return { dialect: db.dialect, migrations: rows.map((row) => row.name), counts };
    },
    async snapshotCentralDb(dest: string): Promise<void> {
      if (db.dialect !== 'sqlite') {
        throw new Error(`backups support the SQLite central database only (this install uses ${db.dialect})`);
      }
      await db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    },
  };
}
