/**
 * Backup, verify and restore from the terminal.
 *
 *   pnpm exec tsx scripts/manager-backup.ts create [--machine-identity]
 *   pnpm exec tsx scripts/manager-backup.ts list
 *   pnpm exec tsx scripts/manager-backup.ts verify <id|file>
 *   pnpm exec tsx scripts/manager-backup.ts restore <id|file> [--rehearsal] [--machine-identity] [--yes]
 *   pnpm exec tsx scripts/manager-backup.ts commit <transaction>
 *   pnpm exec tsx scripts/manager-backup.ts rollback <transaction>
 *   pnpm exec tsx scripts/manager-backup.ts prune [--keep-last N] [--keep-monthly N]
 *
 * The key is never taken from the command line. Provide it with the
 * MANAGER_BACKUP_KEY environment variable, `--key-file <path>`, or type it at
 * the hidden prompt.
 *
 * Backups go to $MANAGER_BACKUP_DIR (default ~/.local/share/nanoclaw-backups/<install>).
 * Keep copies somewhere other than the disk that holds the install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';
import { getInstallSlug } from '../src/install-slug.js';
// Registers module migrations so the restore can tell what this code knows about.
import '../src/modules/index.js';
import { parseKey } from '../src/modules/manager-backup/crypto.js';
import {
  hostIsRunning,
  commitRestore,
  restoreBundle,
  rollbackRestore,
  planRestore,
} from '../src/modules/manager-backup/restore.js';
import { BackupService } from '../src/modules/manager-backup/service.js';
import { createUpstreamHost } from '../src/modules/manager-backup/upstream-host.js';

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (['key-file', 'keep-last', 'keep-monthly', 'dir'].includes(name) && next !== undefined) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`manager-backup: ${message}`);
  process.exit(1);
}

async function readSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) fail('no key provided; set MANAGER_BACKUP_KEY or use --key-file');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput.bind(rl);
  process.stderr.write(question);
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => undefined;
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = write;
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

async function obtainKey(flags: Map<string, string | true>): Promise<Buffer> {
  const file = flags.get('key-file');
  const text =
    typeof file === 'string'
      ? fs.readFileSync(file, 'utf8')
      : (process.env.MANAGER_BACKUP_KEY ?? (await readSecret('Backup key: ')));
  return parseKey(text);
}

function backupsDir(flags: Map<string, string | true>): string {
  const dir = flags.get('dir');
  if (typeof dir === 'string') return path.resolve(dir);
  if (process.env.MANAGER_BACKUP_DIR) return path.resolve(process.env.MANAGER_BACKUP_DIR);
  return path.join(os.homedir(), '.local', 'share', 'nanoclaw-backups', getInstallSlug());
}

function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function resolveBundle(service: BackupService, target: string): string {
  return fs.existsSync(target) ? path.resolve(target) : service.fileFor(target);
}

async function openDatabase(): Promise<DbDriver> {
  return initDb(CENTRAL_DB_PATH, { role: 'tool' });
}

/** A database handle for commands that must work even when the central database is missing. */
function absentDatabase(): DbDriver {
  const missing = (): never => {
    throw new Error('the central database is not available');
  };
  return new Proxy({} as DbDriver, { get: () => missing });
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;

  if (command === 'restore' || command === 'commit' || command === 'rollback') {
    const host = createUpstreamHost({ db: absentDatabase() });
    const service = new BackupService({ host, backupsDir: backupsDir(flags) });
    if (command === 'commit' || command === 'rollback') {
      if (!target) fail(`usage: ${command} <transaction>`);
      if (command === 'commit') await commitRestore(host, target);
      else await rollbackRestore(host, target);
      console.log(`${command}: done`);
      return;
    }
    if (!target) fail('usage: restore <id|file> [--rehearsal] [--machine-identity] [--yes]');
    if (await hostIsRunning(host)) fail('the NanoClaw host is running; stop the service first');
    const bundle = resolveBundle(service, target);
    const key = await obtainKey(flags);
    const plan = await planRestore(host, bundle, key);
    const mode = flags.has('rehearsal') ? 'rehearsal' : 'full';
    console.log(
      `Backup ${plan.manifest.id} from ${plan.manifest.createdAt} (release ${plan.manifest.source.version}, ${plan.manifest.consistency})`,
    );
    console.log(
      `Mode: ${mode}${mode === 'rehearsal' ? ' (channel credentials, stores and identity are NOT restored; pending work is paused)' : ''}`,
    );
    console.log(
      `Migrations to run on first start: ${plan.migrationsToRun.length ? plan.migrationsToRun.join(', ') : 'none'}`,
    );
    for (const warning of plan.warnings) console.log(`Warning: ${warning}`);
    console.log(
      'Everything newer than this backup (messages, memory, tasks) will be replaced. A rollback copy is kept until you commit.',
    );
    if (!flags.has('yes')) {
      const answer = await new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('Type RESTORE to continue: ', (text) => {
          rl.close();
          resolve(text);
        });
      });
      if (answer.trim() !== 'RESTORE') fail('cancelled');
    }
    const result = await restoreBundle({
      host,
      bundleFile: bundle,
      key,
      mode,
      restoreMachineIdentity: flags.has('machine-identity'),
    });
    console.log(`Restored. Transaction: ${result.txn}`);
    if (result.rebuildGroups.length)
      console.log(
        `Rebuild derived images for: ${result.rebuildGroups.join(', ')} (ncl groups restart --id <group> --rebuild)`,
      );
    if (result.keptEnvKeys.length)
      console.log(`Kept this machine's own settings in .env instead of the backup's: ${result.keptEnvKeys.join(', ')}`);
    if (result.droppedEnvKeys.length)
      console.log(`Rehearsal dropped these .env keys: ${result.droppedEnvKeys.join(', ')}`);
    if (!result.upgradeMarkerPreserved)
      console.log('This install had no upgrade marker; run: pnpm exec tsx scripts/upgrade-state.ts set');
    console.log(
      `Start the service and check it. Then run "commit ${result.txn}" to discard the rollback copy, or "rollback ${result.txn}" to undo.`,
    );
    return;
  }

  const db = await openDatabase();
  try {
    const host = createUpstreamHost({ db });
    const service = new BackupService({ host, backupsDir: backupsDir(flags) });
    if (command === 'create') {
      const stopped = !(await hostIsRunning(host));
      if (!stopped)
        console.error(
          'Note: the host is running; the backup will be best-effort (each database file is still consistent).',
        );
      const { record, key } = await service.create({
        includeMachineIdentity: flags.has('machine-identity'),
        hostStopped: stopped,
        force: true,
      });
      console.log(
        `Backup ${record.id} (${human(record.bytes)}, ${record.consistency}) written to ${service.fileFor(record.id)}`,
      );
      console.log('');
      console.log('KEY (shown once; store it in a password manager, it cannot be recovered):');
      console.log(key);
    } else if (command === 'list') {
      for (const record of service.list()) {
        console.log(
          `${record.id}  ${record.createdAt}  ${human(record.bytes).padStart(9)}  release ${record.release}  ${record.consistency}`,
        );
      }
    } else if (command === 'verify') {
      if (!target) fail('usage: verify <id|file>');
      const result = await (async () => {
        const { verifyBundle } = await import('../src/modules/manager-backup/bundle.js');
        return verifyBundle(resolveBundle(service, target), await obtainKey(flags));
      })();
      console.log(
        `OK: ${result.entries} entries, ${result.files} files, ${human(result.bytes)} of content, release ${result.manifest.source.version}`,
      );
    } else if (command === 'prune') {
      const keepLast = Number(flags.get('keep-last') ?? 7);
      const keepMonthly = Number(flags.get('keep-monthly') ?? 6);
      const removed = service.prune({ keepLast, keepMonthly });
      console.log(removed.length ? `Removed ${removed.length}: ${removed.join(', ')}` : 'Nothing to remove');
    } else {
      fail('usage: create | list | verify <id|file> | restore <id|file> | commit <txn> | rollback <txn> | prune');
    }
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(`manager-backup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
