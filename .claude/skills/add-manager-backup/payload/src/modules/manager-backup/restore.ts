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
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  BUNDLE_POLICY,
  CONFIG_FILES,
  MACHINE_IDENTITY_FILES,
  TXN_DIR,
  bundleLimits,
  freeBytes,
  newBackupId,
  openBundleStream,
  openUntrustedDb,
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
      | 'nothing_to_roll_back'
      | 'invalid_transaction'
      | 'restore_in_progress'
      | 'unsafe_link'
      | 'rollback_failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
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
  /** Files in `~/.config/nanoclaw` the restore replaced (names only); the previous copies are kept for rollback. */
  configReplaced: string[];
  /** Files in the bundle's config area that were not restored (names only): not a known name, not opted in, or unusable. */
  configSkipped: string[];
}

interface JournalRoot {
  name: 'data' | 'groups' | 'store';
  real: string;
  stage: string;
  previous: string;
  /**
   * Names of the children `real` held before the swap, recorded (and persisted) before the first
   * one moves; null until then. Rollback tells the live install's own children from the restored
   * ones by this list, so an interrupted swap never mistakes unmoved originals for restored state.
   */
  originals: string[] | null;
}

/**
 * The journal is written ahead of every destructive step: the intent first, then the action.
 * `staged` nothing live was touched; `swapping` the swap, `.env` or settings may be partly done;
 * `swapped` everything is in place and waits for commit or rollback.
 */
interface Journal {
  txn: string;
  createdAt: string;
  state: 'staged' | 'swapping' | 'swapped' | 'rolled-back' | 'committed';
  roots: JournalRoot[];
  hadEnv: boolean;
  /** `.env` is about to be (or was) rewritten; its previous content is in previous-misc/dotenv. */
  envTouched: boolean;
  configDir: string | null;
  configBackedUp: string[];
  /** Settings files about to be (or were) written; a saved copy of the previous file, if any, is in previous-misc/config. */
  configWritten: string[];
}

const TXN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const KNOWN_CONFIG_NAMES = new Set([...CONFIG_FILES, ...MACHINE_IDENTITY_FILES]);

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true; // exists, owned by someone else
    throw error;
  }
}

/**
 * Run `fn` while holding the install's restore lock (a file beside the transaction directories),
 * so two restores, or a restore and a rollback or commit, never work on the same install at once.
 * A lock whose holder is gone (crash, kill) is taken over. The socket probe in `hostIsRunning`
 * stays: this only guards against other backup commands.
 */
/**
 * The transactions' folder, made private and invisible to Git: until a restore is committed or rolled back it holds
 * the previous .env among other things, and a `git add -A` (an update's baseline commit) must never take it.
 */
export function ensureTxnDir(projectRoot: string): string {
  const dir = path.join(projectRoot, TXN_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { mode: 0o600 });
  return dir;
}

async function withLock<T>(host: BackupHost, fn: () => Promise<T>): Promise<T> {
  const file = path.join(ensureTxnDir(host.projectRoot), '.lock');
  const token = `${process.pid} ${crypto.randomBytes(6).toString('hex')}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      if (attempt > 0 || (Number.isInteger(holder) && pidAlive(holder)))
        throw new RestoreError(
          'restore_in_progress',
          `another restore, rollback or commit is running on this install (lock ${file})`,
        );
      fs.rmSync(file, { force: true }); // left behind by a process that no longer exists
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(file, 'utf8') === token) fs.rmSync(file, { force: true });
      // eslint-disable-next-line no-catch-all/no-catch-all -- releasing a lock that is already gone is fine
    } catch {
      /* nothing to release */
    }
  }
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

const ENV_KEEP_PREFIXES = ['NANOCLAW_', 'ONECLI_', 'OPENCODE_', 'PANEL_'];
/** Runtime tuning that carries no identity (ASSISTANT_* names and numbers are left out on purpose). */
const ENV_KEEP_KEYS = new Set([
  'TZ',
  'LOG_LEVEL',
  'WEBHOOK_PORT',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_PIDS_LIMIT',
  'CONTAINER_RUNTIME_BIN',
  'CONTAINER_IMAGE',
  'CONTAINER_IMAGE_BASE',
]);
/** Even inside kept names, anything that looks like a secret is dropped in rehearsal. */
const ENV_SECRET = /(TOKEN|SECRET|PASS|KEY|PRIVATE|CRED|AUTH|COOKIE|DSN|BEARER|SIGNATURE)/i;
/** A value with credentials in a URL (`scheme://user:secret@host`), whatever the name says. */
const ENV_URL_CREDENTIALS = /:\/\/[^\s/@]*@/;
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
    if (allowed && !ENV_SECRET.test(name) && !ENV_URL_CREDENTIALS.test(line)) kept.push(line);
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
const TARGET_OWNED_ENV = [/^ONECLI_/, /^NANOCLAW_GATEWAY_PROVIDER$/, /^PANEL_/, /^no_proxy$/i, /^VOICE_BIND_HOST$/];

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

type Db = ReturnType<typeof openUntrustedDb>;

function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

interface DbFixups {
  rebuildGroups: string[];
}

function fixCentralDatabase(file: string): DbFixups {
  const db = openUntrustedDb(file);
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

/** Inbound states a message can never leave (the host's own terminal set). */
const INBOUND_FINAL = "('completed', 'failed', 'cancelled')";

/**
 * Make the restored mailboxes inert: tasks that could still run are paused, every other inbound
 * message that could still be processed is closed, and every outbound message that was not yet
 * delivered is marked failed in the host's delivery ledger so it is never sent. History stays.
 * Never follows a link: a session directory or database that is not a plain one is left alone.
 */
function neutraliseSessionMailboxes(sessionsDir: string): void {
  const plainDirs = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  if (!fs.lstatSync(sessionsDir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const groupDir of plainDirs(sessionsDir)) {
    for (const sessionDir of plainDirs(groupDir)) {
      const inbound = path.join(sessionDir, 'inbound.db');
      const outbound = path.join(sessionDir, 'outbound.db');
      if (!fs.lstatSync(inbound, { throwIfNoEntry: false })?.isFile()) continue;
      const db = openUntrustedDb(inbound);
      try {
        if (hasTable(db, 'messages_in')) {
          db.exec(
            `UPDATE messages_in SET status = 'paused' WHERE kind = 'task' AND status IS NOT 'paused' AND COALESCE(status, 'pending') NOT IN ${INBOUND_FINAL}`,
          );
          db.exec(
            `UPDATE messages_in SET status = 'completed' WHERE kind != 'task' AND COALESCE(status, 'pending') NOT IN ${INBOUND_FINAL}`,
          );
        }
        if (fs.lstatSync(outbound, { throwIfNoEntry: false })?.isFile()) markOutboundUndeliverable(db, outbound);
      } finally {
        db.close();
      }
    }
  }
}

/** Record every message in `outbound` as failed in the delivery ledger (a table of the inbound database). */
function markOutboundUndeliverable(inbound: Db, outboundFile: string): void {
  const out = openUntrustedDb(outboundFile, { readonly: true });
  try {
    if (!hasTable(out, 'messages_out')) return;
    inbound.exec(
      "CREATE TABLE IF NOT EXISTS delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL)",
    );
    const mark = inbound.prepare(
      "INSERT OR IGNORE INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, 'failed', datetime('now'))",
    );
    inbound.transaction(() => {
      for (const row of out.prepare('SELECT id FROM messages_out').iterate() as Iterable<{ id: unknown }>)
        mark.run(String(row.id));
    })();
  } finally {
    out.close();
  }
}

/**
 * Defence in depth after extraction: every link in the staged tree must resolve (physically,
 * through any other link) to somewhere inside the tree, or be a container-side `/app/` link that
 * dangles on the host. Dangling relative links are fine; a loop or an escape is not. `groups/` and
 * `store/` hold arbitrary links by design and are not checked: nothing in a restore enters them.
 */
export function assertLinksContained(root: string): void {
  const base = fs.realpathSync(root);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) {
        if (fs.readlinkSync(full).startsWith('/app/')) continue;
        let resolved: string;
        try {
          resolved = fs.realpathSync(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw new RestoreError('unsafe_link', `a link in the backup loops or cannot be resolved: ${full}`);
        }
        if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))
          throw new RestoreError('unsafe_link', `a link in the backup leaves the data directory: ${full}`);
      }
    }
  };
  walk(base);
}

async function realOrCreate(dir: string): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  return fs.promises.realpath(dir);
}

/** Write through a fresh, exclusively created temp file (a planted link cannot redirect it), then rename. */
function atomicWrite(file: string, content: Buffer, mode: number): void {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = -1;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd >= 0) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
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
  let journal: Journal;
  try {
    journal = JSON.parse(fs.readFileSync(path.join(txnDir, 'journal.json'), 'utf8')) as Journal;
  } catch {
    throw new RestoreError('incomplete_transaction', `no readable journal in ${txnDir}`);
  }
  // Journals from before write-ahead recording: a `swapped` one had finished its swap, so every
  // child of a root is restored state; any other state with a displaced root cannot be told apart.
  journal.envTouched ??= true;
  journal.configBackedUp ??= [];
  journal.configWritten ??= [];
  for (const root of journal.roots) root.originals ??= journal.state === 'swapped' ? [] : null;
  return journal;
}

/** Path of the journal directory for a transaction, kept outside the replaced roots. */
export function transactionDir(host: BackupHost, txn: string): string {
  if (!TXN_ID.test(txn))
    throw new RestoreError('invalid_transaction', `${JSON.stringify(txn)} is not a transaction id`);
  return path.join(host.projectRoot, TXN_DIR, txn);
}

/** The journal drives recursive moves and deletes, so it must describe this install's own roots. */
function checkJournal(host: BackupHost, journal: Journal, txn: string): void {
  const own: Record<string, string> = { data: host.dataDir, groups: host.groupsDir, store: host.storeDir };
  const bad = (why: string): RestoreError =>
    new RestoreError('incomplete_transaction', `the journal of ${txn} does not match this install (${why})`);
  if (journal.txn !== txn) throw bad('transaction id');
  for (const root of journal.roots) {
    const expected = own[root.name];
    if (!expected) throw bad(`root ${String(root.name)}`);
    let real: string;
    try {
      real = fs.realpathSync(expected);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      real = path.resolve(expected);
    }
    const base = path.join(real, TXN_DIR, txn);
    if (root.real !== real || root.stage !== path.join(base, 'stage') || root.previous !== path.join(base, 'previous'))
      throw bad(`paths of ${root.name}`);
  }
  if (journal.configDir !== host.homeConfigDir) throw bad('settings directory');
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export async function restoreBundle(options: RestoreOptions): Promise<RestoreResult> {
  const { host } = options;
  return withLock(host, () => restoreLocked(options));
}

/** Free space kept back on each filesystem when sizing the staged copy. */
const STAGE_MARGIN = 1.05;

async function restoreLocked(options: RestoreOptions): Promise<RestoreResult> {
  const { host, bundleFile, key, mode } = options;
  if (!options.skipHostProbe && (await hostIsRunning(host))) {
    throw new RestoreError('host_running', 'the NanoClaw host is running; stop the service before restoring');
  }
  const plan = await planRestore(host, bundleFile, key);
  // Reads the whole bundle against the manifest's own counts and sizes (and checks temp space).
  const verified = await verifyBundle(bundleFile, key);

  const txn = newBackupId();
  const txnDir = transactionDir(host, txn);

  const rootDirs: Array<['data' | 'groups' | 'store', string]> = [
    ['data', host.dataDir],
    ['groups', host.groupsDir],
    ['store', host.storeDir],
  ];
  const roots: JournalRoot[] = [];
  for (const [name, dir] of rootDirs) {
    const real = await realOrCreate(dir);
    const base = path.join(real, TXN_DIR, txn);
    roots.push({ name, real, stage: path.join(base, 'stage'), previous: path.join(base, 'previous'), originals: null });
  }

  // Space check against the byte counts the verification just confirmed: the staged copy is the
  // only extra cost (swaps are renames). Each root needs room for its own part of the bundle on
  // its filesystem, and the transaction directory for the database snapshot, `.env` and settings.
  const needs = new Map<string, { free: number; need: number }>();
  const reserve = async (dir: string, bytes: number): Promise<void> => {
    const device = String((await fs.promises.stat(dir)).dev);
    const entry = needs.get(device) ?? { free: await freeBytes(dir), need: 0 };
    entry.need += Math.ceil(bytes * STAGE_MARGIN);
    needs.set(device, entry);
  };
  for (const root of roots) await reserve(root.real, verified.byTop[root.name] ?? 0);
  await reserve(host.projectRoot, (verified.byTop.db ?? 0) + (verified.byTop.env ?? 0) + (verified.byTop.config ?? 0));
  for (const { free, need } of needs.values()) {
    if (need > free)
      throw new RestoreError(
        'insufficient_space',
        'not enough free disk space to stage the restore next to the current data',
      );
  }

  await fs.promises.mkdir(txnDir, { recursive: true, mode: 0o700 });
  const miscStage = path.join(txnDir, 'stage-misc');
  await fs.promises.mkdir(miscStage, { recursive: true, mode: 0o700 });

  const journal: Journal = {
    txn,
    createdAt: new Date().toISOString(),
    state: 'staged',
    roots,
    hadEnv: fs.existsSync(host.envFile),
    envTouched: false,
    configDir: host.homeConfigDir,
    configBackedUp: [],
    configWritten: [],
  };
  const persist = (): void => writeJournal(txnDir, journal);
  persist();

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
      limits: bundleLimits(plan.manifest),
    });
    assertLinksContained(roots[0].stage);

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

    // 5. Swap. Children move; the roots themselves stay. What each root holds is recorded first, so
    // that a rollback after an interruption knows which children are the live install's own.
    for (const root of roots) root.originals = fs.readdirSync(root.real).filter((name) => name !== TXN_DIR);
    journal.state = 'swapping';
    persist();
    for (const root of roots) {
      moveChildren(root.real, root.previous, TXN_DIR);
      moveChildren(root.stage, root.real, TXN_DIR);
    }

    // 6. `.env` and machine-level settings. The previous content is saved before the intent is
    // recorded, and the intent before the write.
    const previousMisc = path.join(txnDir, 'previous-misc');
    fs.mkdirSync(previousMisc, { recursive: true, mode: 0o700 });
    if (journal.hadEnv) fs.copyFileSync(host.envFile, path.join(previousMisc, 'dotenv'));
    journal.envTouched = true;
    persist();
    if (envText !== null) atomicWrite(host.envFile, Buffer.from(envText), 0o600);
    else if (journal.hadEnv) fs.rmSync(host.envFile);

    const configReplaced: string[] = [];
    const configSkipped: string[] = [];
    if (host.homeConfigDir) {
      const stagedConfig = path.join(miscStage, 'config', 'nanoclaw');
      const allowIdentity = mode === 'full' && options.restoreMachineIdentity === true;
      if (fs.existsSync(stagedConfig)) {
        fs.mkdirSync(host.homeConfigDir, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(stagedConfig).sort()) {
          const source = path.join(stagedConfig, name);
          // Only the known settings files, and identity files only when asked for: a bundle must not
          // be able to plant other files (a backup key, say) in the settings directory.
          const wanted =
            (CONFIG_FILES.includes(name) && (mode === 'full' || name === 'mount-allowlist.json')) ||
            (MACHINE_IDENTITY_FILES.includes(name) && allowIdentity);
          if (!wanted || !fs.lstatSync(source).isFile() || (CONFIG_FILES.includes(name) && !isJson(source))) {
            configSkipped.push(name);
            continue;
          }
          const target = path.join(host.homeConfigDir, name);
          if (fs.existsSync(target)) {
            fs.mkdirSync(path.join(previousMisc, 'config'), { recursive: true, mode: 0o700 });
            fs.copyFileSync(target, path.join(previousMisc, 'config', name));
            journal.configBackedUp.push(name);
          }
          journal.configWritten.push(name);
          persist();
          atomicWrite(target, fs.readFileSync(source), 0o600);
          configReplaced.push(name);
        }
      }
    }
    journal.state = 'swapped';
    persist();
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
      configReplaced,
      configSkipped,
    };
  } catch (error) {
    // Anything that failed before or during the swap is put back. If that fails too, say so loudly
    // and keep the transaction: nothing is deleted until the originals are back in place.
    try {
      rollbackLocked(host, txn);
    } catch (rollbackError) {
      throw new RestoreError(
        'rollback_failed',
        `the restore failed (${(error as Error).message}) and putting the install back failed too (${(rollbackError as Error).message}). Nothing was deleted: fix the cause, then run the rollback of transaction ${txn} again.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function isJson(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unparsable settings file is simply not restored
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rollback / commit
// ---------------------------------------------------------------------------

/** Put the install back the way it was before `restoreBundle` ran. */
export async function rollbackRestore(host: BackupHost, txn: string): Promise<void> {
  transactionDir(host, txn); // refuse a malformed id before taking the lock
  return withLock(host, async () => rollbackLocked(host, txn));
}

/**
 * Undo one root from what is on disk plus the recorded `originals`, in an order that can be
 * repeated after any interruption: displaced originals come back first (anything that took their
 * name moves aside), only then is the rest of the root (restored state) set aside. The set-aside
 * copy is deleted by the caller only once every original is home.
 */
function rollbackRoot(root: JournalRoot): void {
  if (root.originals === null) return; // never touched
  const discarded = path.join(path.dirname(root.previous), 'discarded');
  const aside = (name: string): void => {
    fs.mkdirSync(discarded, { recursive: true, mode: 0o700 });
    fs.renameSync(path.join(root.real, name), path.join(discarded, name));
  };
  if (fs.existsSync(root.previous)) {
    for (const name of fs.readdirSync(root.previous)) {
      if (fs.lstatSync(path.join(root.real, name), { throwIfNoEntry: false })) aside(name); // a restored child with the same name
      fs.renameSync(path.join(root.previous, name), path.join(root.real, name));
    }
  }
  const original = new Set(root.originals);
  for (const name of fs.readdirSync(root.real)) {
    if (name !== TXN_DIR && !original.has(name)) aside(name);
  }
  if (fs.existsSync(root.previous) && fs.readdirSync(root.previous).length > 0)
    throw new RestoreError('incomplete_transaction', `${root.previous} still holds children after the rollback`);
}

function rollbackLocked(host: BackupHost, txn: string): void {
  const txnDir = transactionDir(host, txn);
  const journal = readJournal(txnDir);
  if (journal.state === 'rolled-back' || journal.state === 'committed') {
    throw new RestoreError('nothing_to_roll_back', `transaction ${txn} is already ${journal.state}`);
  }
  checkJournal(host, journal, txn);
  for (const root of journal.roots) rollbackRoot(root);

  const previousMisc = path.join(txnDir, 'previous-misc');
  if (journal.envTouched) {
    const saved = path.join(previousMisc, 'dotenv');
    if (journal.hadEnv) {
      if (!fs.existsSync(saved))
        throw new RestoreError('incomplete_transaction', `the saved copy of .env is missing from ${previousMisc}`);
      atomicWrite(host.envFile, fs.readFileSync(saved), 0o600);
    } else fs.rmSync(host.envFile, { force: true });
  }
  if (journal.configDir) {
    // By what is in previous-misc as well as by the journal's list: a copy is saved before the
    // name is listed, so either one alone can be missing after a crash.
    const savedDir = path.join(previousMisc, 'config');
    const saved = fs.existsSync(savedDir) ? fs.readdirSync(savedDir) : [];
    for (const name of new Set([...journal.configWritten, ...saved])) {
      if (!KNOWN_CONFIG_NAMES.has(name)) continue;
      const backup = path.join(savedDir, name);
      if (fs.existsSync(backup)) atomicWrite(path.join(journal.configDir, name), fs.readFileSync(backup), 0o600);
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
  transactionDir(host, txn);
  return withLock(host, async () => {
    const txnDir = transactionDir(host, txn);
    const journal = readJournal(txnDir);
    if (journal.state !== 'swapped')
      throw new RestoreError('nothing_to_roll_back', `transaction ${txn} is ${journal.state}, not swapped`);
    checkJournal(host, journal, txn);
    journal.state = 'committed';
    writeJournal(txnDir, journal);
    cleanupTransaction(journal, txnDir);
    pruneFinishedJournals(host, txn);
  });
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
