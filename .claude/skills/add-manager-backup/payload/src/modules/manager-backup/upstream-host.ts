/**
 * The real `BackupHost`, backed by upstream NanoClaw internals.
 *
 * This is the only file in the module that imports upstream code (besides the
 * barrel wiring). When upstream renames or moves something, this is where the
 * compatibility build breaks and where the fix goes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export interface UpstreamHostOptions {
  db: DbDriver;
  /** Count of running agent containers; only available inside the host process. */
  activeContainerCount?: () => number;
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
    registeredMigrations: () => getRegisteredMigrations().map((migration) => migration.name),
    activeContainerCount: options.activeContainerCount,
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
