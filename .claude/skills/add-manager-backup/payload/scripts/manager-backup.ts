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
 * Scheduled backups (weekly, with their own key; see `schedule` below):
 *
 *   pnpm exec tsx scripts/manager-backup.ts schedule init-key      create the key, shown once
 *   pnpm exec tsx scripts/manager-backup.ts schedule install [--keep 3] [--weekday Sun] [--time 03:30]
 *   pnpm exec tsx scripts/manager-backup.ts schedule status
 *   pnpm exec tsx scripts/manager-backup.ts schedule remove
 *   pnpm exec tsx scripts/manager-backup.ts scheduled [--keep N]    what the timer runs
 *
 * The key is never taken from the command line. Provide it with the
 * MANAGER_BACKUP_KEY environment variable, `--key-file <path>`, or type it at
 * the hidden prompt.
 *
 * Backups go to $MANAGER_BACKUP_DIR (default ~/.local/share/nanoclaw-backups/<install>).
 * Keep copies somewhere other than the disk that holds the install.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { CENTRAL_DB_PATH, DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';
import { getInstallSlug } from '../src/install-slug.js';
// Registers module migrations so the restore can tell what this code knows about.
import '../src/modules/index.js';
import { UsageError, looseKeyMode, parseArgs, printable, wholeNumber } from '../src/modules/manager-backup/cli-args.js';
import { parseKey } from '../src/modules/manager-backup/crypto.js';
import {
  hostIsRunning,
  commitRestore,
  restoreBundle,
  rollbackRestore,
  planRestore,
} from '../src/modules/manager-backup/restore.js';
import {
  ScheduleError,
  assertUnitName,
  initScheduledKey,
  readScheduledKey,
  renderUnits,
  scheduledKeyPath,
  validateSchedule,
} from '../src/modules/manager-backup/schedule.js';
import { BackupService } from '../src/modules/manager-backup/service.js';
import { countBusySessions, createUpstreamHost } from '../src/modules/manager-backup/upstream-host.js';

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
  if (typeof file === 'string' && looseKeyMode(fs.statSync(file).mode))
    console.error(`Warning: ${file} can be read by other users; restrict it with: chmod 600 <file>`);
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

/** A backup must not start unless the disk can hold the next one next to the existing ones. */
function assertFreeSpace(dir: string, service: BackupService): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = fs.statfsSync(dir);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const latest = service.list()[0]?.bytes ?? 0;
  const needed = Math.max(1024 ** 3, Math.ceil(latest * 1.1));
  if (free < needed)
    fail(`not enough free disk space for a backup: ${human(free)} free, about ${human(needed)} needed`);
}

function systemctl(args: string[]): string {
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
  };
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function unitNames(): { name: string; dir: string } {
  return {
    name: assertUnitName(`nanoclaw-backup-${getInstallSlug()}`),
    dir: path.join(os.homedir(), '.config', 'systemd', 'user'),
  };
}

async function scheduleCommand(sub: string | undefined, flags: Map<string, string | true>): Promise<void> {
  const keyFile = scheduledKeyPath(os.homedir());
  const { name, dir } = unitNames();
  if (sub === 'init-key') {
    const key = initScheduledKey(keyFile);
    console.log(`Key file written to ${keyFile} (mode 0600).`);
    console.log('');
    console.log(
      'KEY (shown once; store a copy in a password manager. Without it the scheduled backups cannot be opened):',
    );
    console.log(key);
    return;
  }
  if (sub === 'install') {
    const settings = validateSchedule({
      keep: flags.get('keep'),
      weekday: flags.get('weekday'),
      time: flags.get('time'),
    });
    readScheduledKey(keyFile); // fails with a clear message when `schedule init-key` has not been run
    const projectRoot = process.cwd();
    if (!fs.existsSync(path.join(projectRoot, 'scripts', 'manager-backup.ts')))
      fail('run this from the NanoClaw install folder');
    let tsxCli: string;
    try {
      tsxCli = createRequire(path.join(projectRoot, 'package.json')).resolve('tsx/cli');
    } catch {
      tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    }
    if (!fs.existsSync(tsxCli)) fail(`tsx was not found (${tsxCli}); run pnpm install`);
    const units = renderUnits({ name, projectRoot, nodeBin: process.execPath, tsxCli, settings });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.service`), units.service, { mode: 0o644 });
    fs.writeFileSync(path.join(dir, `${name}.timer`), units.timer, { mode: 0o644 });
    systemctl(['daemon-reload']);
    systemctl(['enable', '--now', `${name}.timer`]);
    console.log(
      `Scheduled: every ${settings.weekday} at ${settings.time}, keeping the last ${settings.keep} scheduled backups.`,
    );
    console.log('Manual backups are never deleted by it. The user service manager must keep running without a login:');
    console.log('  sudo loginctl enable-linger "$USER"    (once)');
    console.log(`Next run: ${nextRun(name)}`);
    return;
  }
  if (sub === 'status') {
    const host = createUpstreamHost({ db: absentDatabase() });
    const service = new BackupService({ host, backupsDir: backupsDir(flags) });
    let keyState = 'present';
    try {
      readScheduledKey(keyFile);
    } catch (error) {
      keyState = error instanceof ScheduleError ? error.message : String(error);
    }
    console.log(`Key: ${keyState}`);
    let timer = 'not installed';
    try {
      timer = systemctl(['show', `${name}.timer`, '-p', 'LoadState', '-p', 'ActiveState', '--value'])
        .trim()
        .split('\n')
        .map(printable)
        .join(', ');
    } catch {
      /* no user manager or no unit */
    }
    console.log(`Timer: ${timer}`);
    console.log(`Next run: ${nextRun(name)}`);
    const scheduled = service.list().filter((record) => record.trigger === 'scheduled');
    console.log(`Scheduled backups kept: ${scheduled.length}`);
    for (const record of scheduled)
      console.log(
        `  ${printable(record.id)}  ${printable(record.createdAt)}  ${human(record.bytes).padStart(9)}  ${printable(record.consistency)}`,
      );
    return;
  }
  if (sub === 'remove') {
    try {
      systemctl(['disable', '--now', `${name}.timer`]);
    } catch {
      /* it was not installed */
    }
    for (const suffix of ['timer', 'service']) fs.rmSync(path.join(dir, `${name}.${suffix}`), { force: true });
    try {
      systemctl(['daemon-reload']);
    } catch {
      /* no user manager */
    }
    console.log('The timer is removed. The key file and the backups were left in place:');
    console.log(`  ${keyFile}`);
    return;
  }
  fail('usage: schedule <init-key|install [--keep N] [--weekday Sun] [--time HH:MM]|status|remove>');
}

function nextRun(name: string): string {
  try {
    const text = systemctl(['show', `${name}.timer`, '-p', 'NextElapseUSecRealtime', '--value']).trim();
    return text || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) fail(error.message);
    throw error;
  }
  const { positional, flags } = parsed;
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
      `Backup ${printable(plan.manifest.id)} from ${printable(plan.manifest.createdAt)} (release ${printable(plan.manifest.source.version)}, ${printable(plan.manifest.consistency)})`,
    );
    console.log(
      `Mode: ${mode}${mode === 'rehearsal' ? ' (channel credentials, stores and identity are NOT restored; pending work is paused)' : ''}`,
    );
    console.log(
      `Migrations to run on first start: ${plan.migrationsToRun.length ? plan.migrationsToRun.map(printable).join(', ') : 'none'}`,
    );
    for (const warning of plan.warnings) console.log(`Warning: ${printable(warning)}`);
    if (plan.credentialsToReenter.length)
      console.log(
        `Credentials to enter again in the gateway after the restore (they are not part of a backup): ${plan.credentialsToReenter.map(printable).join(', ')}`,
      );
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
    console.log(`Restored. Transaction: ${printable(result.txn)}`);
    if (result.rebuildGroups.length)
      console.log(
        `Rebuild derived images for: ${result.rebuildGroups.map(printable).join(', ')} (ncl groups restart --id <group> --rebuild)`,
      );
    if (result.keptEnvKeys.length)
      console.log(
        `Kept this machine's own settings in .env instead of the backup's: ${result.keptEnvKeys.map(printable).join(', ')}`,
      );
    if (result.adoptedEnvKeys.length)
      console.log(
        `This machine had none, so the backup's value was used for: ${result.adoptedEnvKeys.map(printable).join(', ')}`,
      );
    if (result.configReplaced.length)
      console.log(
        `Replaced machine settings files in ~/.config/nanoclaw with the backup's (the previous ones are in the rollback copy): ${result.configReplaced.map(printable).join(', ')}`,
      );
    if (result.configSkipped.length)
      console.log(
        `Left alone, because a restore does not write them: ${result.configSkipped.map(printable).join(', ')}`,
      );
    if (result.droppedEnvKeys.length)
      console.log(`Rehearsal dropped these .env keys: ${result.droppedEnvKeys.map(printable).join(', ')}`);
    if (!result.upgradeMarkerPreserved)
      console.log('This install had no upgrade marker; run: pnpm exec tsx scripts/upgrade-state.ts set');
    console.log(
      `Start the service and check it. Then run "commit ${printable(result.txn)}" to discard the rollback copy, or "rollback ${printable(result.txn)}" to undo.`,
    );
    return;
  }

  if (command === 'schedule') {
    await scheduleCommand(target, flags);
    return;
  }

  const db = await openDatabase();
  try {
    const host = createUpstreamHost({ db, busyAgentCount: () => countBusySessions(DATA_DIR) });
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
        `Backup ${printable(record.id)} (${human(record.bytes)}, ${printable(record.consistency)}) written to ${printable(service.fileFor(record.id))}`,
      );
      console.log('');
      console.log('KEY (shown once; store it in a password manager, it cannot be recovered):');
      console.log(key);
    } else if (command === 'list') {
      for (const record of service.list()) {
        console.log(
          `${printable(record.id)}  ${printable(record.createdAt)}  ${human(record.bytes).padStart(9)}  release ${printable(record.release)}  ${printable(record.consistency)}`,
        );
      }
    } else if (command === 'verify') {
      if (!target) fail('usage: verify <id|file>');
      const result = await (async () => {
        const { verifyBundle } = await import('../src/modules/manager-backup/bundle.js');
        return verifyBundle(resolveBundle(service, target), await obtainKey(flags));
      })();
      console.log(
        `OK: ${result.entries} entries, ${result.files} files, ${human(result.bytes)} of content, release ${printable(result.manifest.source.version)}`,
      );
    } else if (command === 'scheduled') {
      const { keep } = validateSchedule({ keep: flags.get('keep') });
      const key = readScheduledKey(scheduledKeyPath(os.homedir()));
      assertFreeSpace(backupsDir(flags), service);
      const stopped = !(await hostIsRunning(host));
      // Wait a while for agents to finish a message so the copy is consistent, then go ahead either way.
      const { record } = await service.create({
        hostStopped: stopped,
        force: true,
        waitMs: 5 * 60_000,
        key,
        trigger: 'scheduled',
      });
      console.log(
        `Scheduled backup ${printable(record.id)} (${human(record.bytes)}, ${printable(record.consistency)}) written to ${printable(service.fileFor(record.id))}`,
      );
      const removed = service.pruneScheduled(keep);
      console.log(
        removed.length
          ? `Removed ${removed.length} older scheduled backup(s): ${removed.map(printable).join(', ')}`
          : `No older scheduled backups to remove (keeping the last ${keep})`,
      );
    } else if (command === 'prune') {
      const keepLast = wholeNumber('keep-last', flags.get('keep-last'), 1, 7);
      const keepMonthly = wholeNumber('keep-monthly', flags.get('keep-monthly'), 0, 6);
      const removed = service.prune({ keepLast, keepMonthly });
      console.log(
        removed.length ? `Removed ${removed.length}: ${removed.map(printable).join(', ')}` : 'Nothing to remove',
      );
    } else {
      fail(
        'usage: create | list | verify <id|file> | restore <id|file> | commit <txn> | rollback <txn> | prune | schedule <init-key|install|status|remove> | scheduled',
      );
    }
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error(`manager-backup: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
