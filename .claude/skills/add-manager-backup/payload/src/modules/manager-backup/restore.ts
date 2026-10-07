/**
 * Restore a backup bundle into an install, with a way back.
 *
 * The service must be stopped. The bundle is authenticated and validated
 * before anything is touched. It is extracted into staging directories that sit
 * on the same filesystem as the directory they will replace, then each root
 * (`data/`, `groups/`, `store/`) is swapped by moving its children, never the
 * root itself: a root that is a symlink or a mount point keeps its identity.
 * Everything displaced goes to a `previous` directory next to the staging
 * area, and a journal records enough to put it all back.
 *
 * Fix-ups applied to the restored database so the host can start cleanly:
 *   - sessions are marked stopped (no containers survive a restore);
 *   - host leases and session claims are cleared (they describe a process that
 *     no longer exists);
 *   - derived image tags are cleared (images are not part of a backup) and the
 *     affected groups are reported so they can be rebuilt.
 *
 * Rehearsal mode additionally removes everything that could act as the
 * original's identity on the outside world: it starts from a default-deny
 * allowlist rather than trying to enumerate channel secrets.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  BUNDLE_POLICY,
  MACHINE_IDENTITY_FILES,
  TXN_DIR,
  newBackupId,
  openBundleStream,
  readManifest,
  verifyBundle,
  type BundleManifest,
} from './bundle.js';
import type { BackupHost } from './host.js';
import { extractTar } from './tar.js';

export class RestoreError extends Error {
  constructor(
    readonly code:
      | 'host_running'
      | 'backup_newer'
      | 'unsupported_database'
      | 'insufficient_space'
      | 'incomplete_transaction'
      | 'nothing_to_roll_back',
    message: string,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

export type RestoreMode = 'full' | 'rehearsal';

export interface RestorePlan {
  manifest: BundleManifest;
  /** Migrations the host will apply on first start (backup is older than the code). */
  migrationsToRun: string[];
  /** Same code version as the backup? */
  sameRelease: boolean;
  warnings: string[];
  /** Gateway credentials the backup's machine had that this machine does not (names only): enter them again. */
  credentialsToReenter: string[];
}

export interface RestoreOptions {
  host: BackupHost;
  bundleFile: string;
  key: Buffer;
  mode: RestoreMode;
  /** Restore device-key / account / host-id too. Never done in rehearsal mode. */
  restoreMachineIdentity?: boolean;
  /** Skip the host-running probe (tests only). */
  skipHostProbe?: boolean;
}

export interface RestoreResult {
  txn: string;
  txnDir: string;
  plan: RestorePlan;
  mode: RestoreMode;
  /** Groups whose derived image must be rebuilt (`ncl groups restart --rebuild`). */
  rebuildGroups: string[];
  /** `.env` keys kept from this machine instead of the backup (names only). */
  keptEnvKeys: string[];
  /** `.env` settings added because this machine had none and the backup's is usable here (names only). */
  adoptedEnvKeys: string[];
  /** `.env` keys dropped by rehearsal mode (names only). */
  droppedEnvKeys: string[];
  /** The previous `.env`, upgrade marker and state were kept for rollback. */
  upgradeMarkerPreserved: boolean;
}

interface JournalRoot {
  name: 'data' | 'groups' | 'store';
  real: string;
  stage: string;
  previous: string;
}

interface Journal {
  txn: string;
  createdAt: string;
  state: 'staged' | 'swapped' | 'rolled-back' | 'committed';
  roots: JournalRoot[];
  hadEnv: boolean;
  configDir: string | null;
  configBackedUp: string[];
  configWritten: string[];
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** True when something is accepting connections on the host's CLI socket. */
export async function hostIsRunning(host: BackupHost): Promise<boolean> {
  const socket = path.join(host.dataDir, 'ncl.sock');
  if (!fs.existsSync(socket)) return false;
  return new Promise((resolve) => {
    const client = net.connect(socket);
    const done = (alive: boolean): void => {
      client.destroy();
      resolve(alive);
    };
    client.once('connect', () => done(true));
    client.once('error', () => done(false));
    client.setTimeout(1500, () => done(false));
  });
}

export async function planRestore(host: BackupHost, bundleFile: string, key: Buffer): Promise<RestorePlan> {
  const manifest = await readManifest(bundleFile, key);
  const current = await host.describeDb().catch(() => null);
  const dialect = current?.dialect ?? 'sqlite';
  if (manifest.db.dialect !== 'sqlite' || dialect !== 'sqlite') {
    throw new RestoreError(
      'unsupported_database',
      `only SQLite installs can be restored (bundle: ${manifest.db.dialect}, host: ${dialect})`,
    );
  }
  const registered = new Set(host.registeredMigrations());
  const unknown = manifest.db.migrations.filter((name) => !registered.has(name));
  if (unknown.length > 0) {
    throw new RestoreError(
      'backup_newer',
      `the backup was made by newer code (unknown migrations: ${unknown.join(', ')}). Update this install first, then restore.`,
    );
  }
  const applied = new Set(manifest.db.migrations);
  const migrationsToRun = [...registered].filter((name) => !applied.has(name));
  const identity = host.identity();
  const warnings: string[] = [];
  if (manifest.source.installSlug !== host.installSlug()) {
    warnings.push(
      'the install identifier differs from the backup; pin NANOCLAW_INSTALL_ID to the original value if image names, labels or unit names must stay the same',
    );
  }
  const missing = [
    ...manifest.installed.channels
      .filter((name) => !host.installed().channels.includes(name))
      .map((name) => `channel ${name}`),
    ...manifest.installed.providers
      .filter((name) => !host.installed().providers.includes(name))
      .map((name) => `provider ${name}`),
    ...(manifest.installed.gateway && !host.installedGateways().includes(manifest.installed.gateway)
      ? [`gateway ${manifest.installed.gateway}`]
      : []),
  ];
  if (missing.length > 0)
    warnings.push(`not installed on this host: ${missing.join(', ')} (reinstall these skills before starting)`);
  const selected = host.installed().gateway;
  if (manifest.installed.gateway && selected && selected !== manifest.installed.gateway)
    warnings.push(
      `this machine uses the ${selected} gateway and the backup used ${manifest.installed.gateway}; ${selected} is kept`,
    );
  let credentialsToReenter = manifest.gatewayCredentials ?? [];
  if (credentialsToReenter.length > 0) {
    const here = new Set((await host.gatewayCredentialNames?.()) ?? []);
    credentialsToReenter = credentialsToReenter.filter((name) => !here.has(name));
  }
  return {
    manifest,
    migrationsToRun,
    sameRelease: manifest.source.commit === identity.commit,
    warnings,
    credentialsToReenter,
  };
}

// ---------------------------------------------------------------------------
// Staging and fix-ups
// ---------------------------------------------------------------------------

const ENV_KEEP_PREFIXES = ['NANOCLAW_', 'ONECLI_', 'OPENCODE_', 'CONTAINER_', 'PANEL_', 'ASSISTANT_'];
const ENV_KEEP_KEYS = new Set(['TZ', 'LOG_LEVEL', 'WEBHOOK_PORT']);
/** Even inside kept prefixes, anything that looks like a secret is dropped in rehearsal. */
const ENV_SECRET = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE)/i;
const REHEARSAL_DATA_KEEP = new Set(['v2-sessions', 'upgrade-state.json']);

export function filterEnvForRehearsal(text: string): { kept: string; dropped: string[] } {
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) {
      if (line.trim() === '' || line.trim().startsWith('#')) kept.push(line);
      continue;
    }
    const name = match[1];
    const allowed = ENV_KEEP_KEYS.has(name) || ENV_KEEP_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (allowed && !ENV_SECRET.test(name)) kept.push(line);
    else dropped.push(name);
  }
  return { kept: kept.join('\n').replace(/\n{3,}$/, '\n'), dropped };
}

/**
 * Settings that describe this machine's infrastructure rather than the install's data: where its
 * credential gateway is, which gateway is installed, the panel's own address, proxy exclusions.
 * A backup from another machine must not overwrite them, or the restored install would look for a
 * gateway that is not there.
 */
const TARGET_OWNED_ENV = [/^ONECLI_/, /^NANOCLAW_GATEWAY_PROVIDER$/, /^PANEL_/, /^no_proxy$/i];

export function isTargetOwnedEnv(key: string): boolean {
  return TARGET_OWNED_ENV.some((pattern) => pattern.test(key));
}

function envKey(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
}

export function mergeTargetOwnedEnv(
  bundleText: string | null,
  targetText: string | null,
): { text: string | null; kept: string[] } {
  const owned = (key: string): boolean => TARGET_OWNED_ENV.some((pattern) => pattern.test(key));
  const targetLines = (targetText ?? '').split('\n').filter((line) => {
    const key = envKey(line);
    return key !== null && owned(key);
  });
  if (bundleText === null && targetLines.length === 0) return { text: null, kept: [] };
  const bundleLines = (bundleText ?? '')
    .replace(/\n$/, '')
    .split('\n')
    .filter((line) => {
      const key = envKey(line);
      return key === null || !owned(key);
    });
  const text = [
    ...bundleLines.filter((line, index, all) => !(line === '' && (index === 0 || all[index - 1] === ''))),
    ...targetLines,
  ].join('\n');
  return { text: text === '' ? null : `${text}\n`, kept: [...new Set(targetLines.map((line) => envKey(line)!))] };
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

interface DbFixups {
  rebuildGroups: string[];
}

function fixCentralDatabase(file: string): DbFixups {
  const db = new Database(file);
  try {
    const rebuildGroups: string[] = [];
    db.transaction(() => {
      if (hasTable(db, 'sessions'))
        db.exec("UPDATE sessions SET container_status = 'stopped' WHERE container_status IS NOT 'stopped'");
      for (const table of ['host_instances', 'session_claims'])
        if (hasTable(db, table)) db.exec(`DELETE FROM ${table}`);
      if (hasTable(db, 'container_configs')) {
        const rows = db
          .prepare(
            "SELECT agent_group_id FROM container_configs WHERE image_tag IS NOT NULL AND image_tag != '' OR packages_apt NOT IN ('[]', '') OR packages_npm NOT IN ('[]', '')",
          )
          .all() as Array<{ agent_group_id: string }>;
        rebuildGroups.push(...rows.map((row) => row.agent_group_id));
        db.exec('UPDATE container_configs SET image_tag = NULL WHERE image_tag IS NOT NULL');
      }
    })();
    return { rebuildGroups };
  } finally {
    db.close();
  }
}

function neutraliseSessionMailboxes(sessionsDir: string): void {
  if (!fs.existsSync(sessionsDir)) return;
  for (const group of fs.readdirSync(sessionsDir)) {
    const groupDir = path.join(sessionsDir, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const session of fs.readdirSync(groupDir)) {
      const inbound = path.join(groupDir, session, 'inbound.db');
      if (!fs.existsSync(inbound)) continue;
      const db = new Database(inbound);
      try {
        if (!hasTable(db, 'messages_in')) continue;
        db.exec("UPDATE messages_in SET status = 'paused' WHERE kind = 'task' AND status = 'pending'");
        db.exec("UPDATE messages_in SET status = 'completed' WHERE kind != 'task' AND status = 'pending'");
      } finally {
        db.close();
      }
    }
  }
}

async function freeBytes(dir: string): Promise<number> {
  const stats = await fs.promises.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function realOrCreate(dir: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  return fs.promises.realpath(dir);
}

function atomicWrite(file: string, content: Buffer, mode: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function moveChildren(from: string, to: string, skip: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(from)) {
    if (name === skip) continue;
    fs.renameSync(path.join(from, name), path.join(to, name));
  }
}

function writeJournal(txnDir: string, journal: Journal): void {
  atomicWrite(path.join(txnDir, 'journal.json'), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`), 0o600);
}

function readJournal(txnDir: string): Journal {
  try {
    return JSON.parse(fs.readFileSync(path.join(txnDir, 'journal.json'), 'utf8')) as Journal;
  } catch {
    throw new RestoreError('incomplete_transaction', `no readable journal in ${txnDir}`);
  }
}

/** Path of the journal directory for a transaction, kept outside the replaced roots. */
export function transactionDir(host: BackupHost, txn: string): string {
  return path.join(host.projectRoot, TXN_DIR, txn);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export async function restoreBundle(options: RestoreOptions): Promise<RestoreResult> {
  const { host, bundleFile, key, mode } = options;
  if (!options.skipHostProbe && (await hostIsRunning(host))) {
    throw new RestoreError('host_running', 'the NanoClaw host is running; stop the service before restoring');
  }
  const plan = await planRestore(host, bundleFile, key);
  await verifyBundle(bundleFile, key);

  const txn = newBackupId();
  const txnDir = transactionDir(host, txn);
  await fs.promises.mkdir(txnDir, { recursive: true, mode: 0o700 });

  const rootDirs: Array<['data' | 'groups' | 'store', string]> = [
    ['data', host.dataDir],
    ['groups', host.groupsDir],
    ['store', host.storeDir],
  ];
  const roots: JournalRoot[] = [];
  for (const [name, dir] of rootDirs) {
    const real = await realOrCreate(dir);
    const base = path.join(real, TXN_DIR, txn);
    roots.push({ name, real, stage: path.join(base, 'stage'), previous: path.join(base, 'previous') });
  }
  const miscStage = path.join(txnDir, 'stage-misc');
  await fs.promises.mkdir(miscStage, { recursive: true, mode: 0o700 });

  // Space check: the staged copy is the only extra cost (swaps are renames).
  const need = plan.manifest.contents.bytes * 1.05;
  const perFilesystem = new Map<string, number>();
  for (const root of roots) {
    const device = String((await fs.promises.stat(root.real)).dev);
    perFilesystem.set(device, (perFilesystem.get(device) ?? (await freeBytes(root.real))) - need / roots.length);
  }
  for (const [, remaining] of perFilesystem) {
    if (remaining < 0)
      throw new RestoreError(
        'insufficient_space',
        'not enough free disk space to stage the restore next to the current data',
      );
  }

  const journal: Journal = {
    txn,
    createdAt: new Date().toISOString(),
    state: 'staged',
    roots,
    hadEnv: fs.existsSync(host.envFile),
    configDir: host.homeConfigDir,
    configBackedUp: [],
    configWritten: [],
  };
  writeJournal(txnDir, journal);

  try {
    // 1. Extract everything into staging.
    const extractRoots: Record<string, string> = {
      db: path.join(miscStage, 'db'),
      env: path.join(miscStage, 'env'),
      config: path.join(miscStage, 'config'),
    };
    for (const root of roots) extractRoots[root.name] = root.stage;
    await extractTar(openBundleStream(bundleFile, key), miscStage, {
      policy: BUNDLE_POLICY,
      roots: extractRoots,
      preserveOwner: true,
    });

    // 2. The database snapshot becomes the central database.
    const stagedData = roots[0].stage;
    const snapshot = path.join(miscStage, 'db', 'v2.db');
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      fs.rmSync(path.join(stagedData, `v2.db${suffix}`), { force: true });
    fs.renameSync(snapshot, path.join(stagedData, 'v2.db'));
    const fixups = fixCentralDatabase(path.join(stagedData, 'v2.db'));

    // 3. Keep this install's own upgrade marker: the bundle's describes other code.
    const liveMarker = path.join(host.dataDir, 'upgrade-state.json');
    const stagedMarker = path.join(stagedData, 'upgrade-state.json');
    fs.rmSync(stagedMarker, { force: true });
    const upgradeMarkerPreserved = fs.existsSync(liveMarker);
    if (upgradeMarkerPreserved) fs.copyFileSync(liveMarker, stagedMarker);

    // 4. Rehearsal: default-deny everything that could act as the original.
    let envText = fs.existsSync(path.join(miscStage, 'env', 'dotenv'))
      ? fs.readFileSync(path.join(miscStage, 'env', 'dotenv'), 'utf8')
      : null;
    let droppedEnvKeys: string[] = [];
    if (mode === 'rehearsal') {
      if (envText !== null) {
        const filtered = filterEnvForRehearsal(envText);
        envText = filtered.kept;
        droppedEnvKeys = filtered.dropped;
      }
      for (const name of fs.readdirSync(stagedData)) {
        if (name !== 'v2.db' && !REHEARSAL_DATA_KEEP.has(name))
          fs.rmSync(path.join(stagedData, name), { recursive: true, force: true });
      }
      fs.rmSync(roots[2].stage, { recursive: true, force: true });
      fs.mkdirSync(roots[2].stage, { recursive: true, mode: 0o700 });
      neutraliseSessionMailboxes(path.join(stagedData, 'v2-sessions'));
    }

    // This machine's own infrastructure settings win over the backup's.
    const merged = mergeTargetOwnedEnv(
      envText,
      fs.existsSync(host.envFile) ? fs.readFileSync(host.envFile, 'utf8') : null,
    );
    envText = merged.text;

    // A machine that has no gateway selected yet (an install that did not finish its setup) takes the
    // backup's choice when that gateway's skill is installed here; otherwise the host would not start.
    const adoptedEnvKeys: string[] = [];
    const backupGateway = plan.manifest.installed.gateway;
    if (
      backupGateway &&
      host.installedGateways().includes(backupGateway) &&
      !/^\s*(?:export\s+)?NANOCLAW_GATEWAY_PROVIDER\s*=/m.test(envText ?? '') &&
      !process.env.NANOCLAW_GATEWAY_PROVIDER?.trim()
    ) {
      envText = `${(envText ?? '').replace(/\n*$/, '')}${envText ? '\n' : ''}NANOCLAW_GATEWAY_PROVIDER=${backupGateway}\n`;
      adoptedEnvKeys.push('NANOCLAW_GATEWAY_PROVIDER');
    }
    // Names this machine's own settings replaced were not "dropped"; they are reported as kept.
    droppedEnvKeys = droppedEnvKeys.filter((name) => !isTargetOwnedEnv(name));

    // 5. Swap. Children move; the roots themselves stay.
    for (const root of roots) {
      moveChildren(root.real, root.previous, TXN_DIR);
      moveChildren(root.stage, root.real, TXN_DIR);
    }
    journal.state = 'swapped';

    // 6. `.env` and machine-level settings.
    const previousMisc = path.join(txnDir, 'previous-misc');
    fs.mkdirSync(previousMisc, { recursive: true, mode: 0o700 });
    if (journal.hadEnv) fs.copyFileSync(host.envFile, path.join(previousMisc, 'dotenv'));
    if (envText !== null) atomicWrite(host.envFile, Buffer.from(envText), 0o600);
    else if (journal.hadEnv) fs.rmSync(host.envFile);

    if (host.homeConfigDir) {
      const stagedConfig = path.join(miscStage, 'config', 'nanoclaw');
      const allowIdentity = mode === 'full' && options.restoreMachineIdentity === true;
      if (fs.existsSync(stagedConfig)) {
        fs.mkdirSync(host.homeConfigDir, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(stagedConfig)) {
          if (MACHINE_IDENTITY_FILES.includes(name) && !allowIdentity) continue;
          if (mode === 'rehearsal' && name !== 'mount-allowlist.json') continue;
          const target = path.join(host.homeConfigDir, name);
          if (fs.existsSync(target)) {
            fs.mkdirSync(path.join(previousMisc, 'config'), { recursive: true, mode: 0o700 });
            fs.copyFileSync(target, path.join(previousMisc, 'config', name));
            journal.configBackedUp.push(name);
          }
          atomicWrite(target, fs.readFileSync(path.join(stagedConfig, name)), 0o600);
          journal.configWritten.push(name);
        }
      }
    }
    writeJournal(txnDir, journal);
    fs.rmSync(miscStage, { recursive: true, force: true });

    return {
      txn,
      txnDir,
      plan,
      mode,
      rebuildGroups: fixups.rebuildGroups,
      keptEnvKeys: merged.kept,
      adoptedEnvKeys,
      droppedEnvKeys,
      upgradeMarkerPreserved,
    };
  } catch (error) {
    // Anything that failed before or during the swap is put back.
    await rollbackRestore(host, txn).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rollback / commit
// ---------------------------------------------------------------------------

/** Put the install back the way it was before `restoreBundle` ran. */
export async function rollbackRestore(host: BackupHost, txn: string): Promise<void> {
  const txnDir = transactionDir(host, txn);
  const journal = readJournal(txnDir);
  if (journal.state === 'rolled-back' || journal.state === 'committed') {
    throw new RestoreError('nothing_to_roll_back', `transaction ${txn} is already ${journal.state}`);
  }
  for (const root of journal.roots) {
    if (!fs.existsSync(root.previous)) continue; // this root was never touched
    // Whatever is in the root now is the restored (or half-restored) state.
    const discarded = path.join(path.dirname(root.previous), 'discarded');
    moveChildren(root.real, discarded, TXN_DIR);
    moveChildren(root.previous, root.real, TXN_DIR);
  }
  const previousMisc = path.join(txnDir, 'previous-misc');
  if (journal.hadEnv && fs.existsSync(path.join(previousMisc, 'dotenv'))) {
    atomicWrite(host.envFile, fs.readFileSync(path.join(previousMisc, 'dotenv')), 0o600);
  } else if (!journal.hadEnv) {
    fs.rmSync(host.envFile, { force: true });
  }
  if (journal.configDir) {
    for (const name of journal.configWritten) {
      const backup = path.join(previousMisc, 'config', name);
      if (journal.configBackedUp.includes(name) && fs.existsSync(backup))
        atomicWrite(path.join(journal.configDir, name), fs.readFileSync(backup), 0o600);
      else fs.rmSync(path.join(journal.configDir, name), { force: true });
    }
  }
  journal.state = 'rolled-back';
  writeJournal(txnDir, journal);
  cleanupTransaction(journal, txnDir);
  pruneFinishedJournals(host, txn);
}

/** Accept the restored state: delete what was kept for rollback. */
export async function commitRestore(host: BackupHost, txn: string): Promise<void> {
  const txnDir = transactionDir(host, txn);
  const journal = readJournal(txnDir);
  if (journal.state !== 'swapped')
    throw new RestoreError('nothing_to_roll_back', `transaction ${txn} is ${journal.state}, not swapped`);
  journal.state = 'committed';
  writeJournal(txnDir, journal);
  cleanupTransaction(journal, txnDir);
  pruneFinishedJournals(host, txn);
}

/** Older finished transactions leave nothing but their journal; keep only the latest one, which lets a repeated command say what happened. */
function pruneFinishedJournals(host: BackupHost, keep: string): void {
  const parent = path.join(host.projectRoot, TXN_DIR);
  if (!fs.existsSync(parent)) return;
  for (const name of fs.readdirSync(parent)) {
    if (name === keep) continue;
    try {
      const journal = readJournal(path.join(parent, name));
      if (journal.state === 'committed' || journal.state === 'rolled-back')
        fs.rmSync(path.join(parent, name), { recursive: true, force: true });
      // eslint-disable-next-line no-catch-all/no-catch-all -- a transaction that cannot be read is left alone
    } catch {
      /* not ours to delete */
    }
  }
}

function cleanupTransaction(journal: Journal, txnDir: string): void {
  for (const root of journal.roots) fs.rmSync(path.dirname(root.previous), { recursive: true, force: true });
  fs.rmSync(path.join(txnDir, 'previous-misc'), { recursive: true, force: true });
  fs.rmSync(path.join(txnDir, 'stage-misc'), { recursive: true, force: true });
  for (const root of journal.roots) {
    const parent = path.join(root.real, TXN_DIR);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  }
}
