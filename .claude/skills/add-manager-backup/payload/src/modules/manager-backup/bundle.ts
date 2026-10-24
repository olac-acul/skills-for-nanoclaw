/**
 * Backup bundle: create, inspect and verify.
 *
 * A bundle is one file: tar -> gzip -> authenticated encryption (see crypto.ts).
 * The first tar member is `manifest.json`, so the version and schema checks
 * can run without reading the rest. Everything else lives under fixed
 * top-level members:
 *
 *   manifest.json   what is in here and where it came from
 *   db/v2.db        consistent snapshot of the central database
 *   data/           the data directory (session mailboxes snapshotted safely)
 *   groups/         agent group folders
 *   store/          channel stores
 *   env/dotenv      the `.env` file
 *   config/nanoclaw machine-level allowlists (and identity files, opt-in)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';

import { CryptoError, decryptStream, encryptStream } from './crypto.js';
import type { BackupHost, DbDescription, InstalledInventory } from './host.js';
import {
  MemberChecker,
  hasInnerParentSegment,
  memberPathProblem,
  packEntries,
  readTar,
  walkTree,
  type ExtractLimits,
  type MemberPolicy,
  type PackItem,
  type TarEntryMeta,
} from './tar.js';

export const BUNDLE_SCHEMA = 'manager-backup/v1';
export const TOOL_VERSION = '0.1.0';
/** Scratch directory a restore keeps inside each root it replaces; never archived. */
export const TXN_DIR = '.manager-backup-txn';
export const TOP_LEVEL = new Set(['manifest.json', 'db', 'data', 'groups', 'store', 'env', 'config']);
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
/** Free space kept back when checking whether a file fits. */
const SPACE_MARGIN = 16 * 1024 * 1024;
/** Entries listed by name in the manifest when a backup leaves some out; the rest are only counted. */
const MAX_SKIPPED_LISTED = 20;

/** Files that identify this machine rather than the install; only backed up on request. */
export const MACHINE_IDENTITY_FILES = ['device-key.json', 'account.json', 'host-id'];
export const CONFIG_FILES = ['mount-allowlist.json', 'sender-allowlist.json'];

export class BundleError extends Error {
  constructor(
    readonly code:
      | 'bad_manifest'
      | 'unsupported_schema'
      | 'missing_member'
      | 'count_mismatch'
      | 'limit_exceeded'
      | 'insufficient_space'
      | 'database_check_failed'
      | 'source_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  id: string;
  createdAt: string;
  tool: { name: 'manager-backup'; version: string };
  source: { version: string; commit: string; tree: string; installSlug: string };
  db: DbDescription;
  installed: InstalledInventory;
  /** Names of the credentials in the gateway when the backup was made (never values); absent when unknown. */
  gatewayCredentials?: string[];
  contents: { entries: number; files: number; bytes: number };
  /** Paths (relative to their roots) of channel or machine credentials that are in the bundle. */
  identities: { machineIdentityIncluded: boolean };
  /**
   * How coherent the snapshot is across files: `cold` (host stopped), `quiescent` (no agent
   * container ran during the snapshot) or `best-effort` (agents were active; every database
   * file is still individually consistent).
   */
  consistency: 'cold' | 'quiescent' | 'best-effort';
  /** Human-readable list of what was deliberately left out. */
  excluded: string[];
}

async function namesOrNothing(host: BackupHost): Promise<{ gatewayCredentials?: string[] }> {
  try {
    const names = await host.gatewayCredentialNames?.();
    return names ? { gatewayCredentials: names } : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- the names are a convenience; a backup never fails for them
  } catch {
    return {};
  }
}

export interface CreateBundleOptions {
  host: BackupHost;
  key: Buffer;
  /** Destination file. Written atomically (`.partial` then rename), mode 0600. */
  destFile: string;
  id?: string;
  includeMachineIdentity?: boolean;
  consistency?: BundleManifest['consistency'];
  gzipLevel?: number;
  onProgress?: (progress: { phase: 'snapshot' | 'pack'; entries: number; bytes: number }) => void;
  /**
   * A best-effort backup (agents at work) goes on when a file vanishes or shrinks while it is read: that file keeps its
   * announced size, padded with zeros, and is reported here. So does a quiescent one, since an agent may start while it
   * runs; the caller then records it as best-effort. A cold backup stops instead.
   */
  onChanged?: (archivePath: string, how: 'vanished' | 'shrank') => void;
}

export function newBackupId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// What goes into the data directory
// ---------------------------------------------------------------------------

const SESSION_DB = /^v2-sessions\/[^/]+\/[^/]+\/(?:inbound|outbound)\.db$/;
const SESSION_DB_SIDECAR = /^v2-sessions\/[^/]+\/[^/]+\/(?:inbound|outbound)\.db-(?:journal|wal|shm)$/;
const TOP_LEVEL_EXCLUDES = new Set([
  'v2.db',
  'v2.db-wal',
  'v2.db-shm',
  'v2.db-journal',
  'circuit-breaker.json',
  // The voice channel's live state: who is connected now, and a pairing code that waits for a phone for five minutes.
  // Neither means anything after a restore, and a restored pairing code could be used on the machine it lands on.
  'voice-status.json',
  'voice-status.json.tmp',
  'voice-pairing.json',
  'voice-pairing.json.tmp',
]);

function includeOutsideTxn(rel: string): boolean {
  return rel.split('/')[0] !== TXN_DIR;
}

/** True when a path under `data/` belongs in the bundle. */
export function includeInData(rel: string, stat: fs.Stats): boolean {
  if (stat.isSocket() || stat.isFIFO()) return false;
  const segments = rel.split('/');
  const name = segments[segments.length - 1];
  if (segments[0] === TXN_DIR) return false;
  if (segments.length === 1 && (TOP_LEVEL_EXCLUDES.has(name) || name.startsWith('Dockerfile.'))) return false;
  if (name === '.heartbeat' || name.endsWith('.lock') || name.endsWith('.sock')) return false;
  if (segments.includes('.context')) return false; // rewritten at every spawn
  if (SESSION_DB_SIDECAR.test(rel)) return false; // covered by the SQLite-aware snapshot
  return true;
}

export const EXCLUDED_DESCRIPTION = [
  'data/v2.db* (replaced by a consistent snapshot at db/v2.db)',
  'sockets, lock files, heartbeats, circuit-breaker state, transient Dockerfiles',
  "the voice channel's live state (who is connected, a waiting pairing code)",
  'per-spawn runner context (.context)',
  'logs, node_modules, git history, container images',
];

/** Snapshot a SQLite file that another process may be writing. */
export function snapshotSqliteFile(source: string, dest: string): void {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 10000');
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/**
 * Open a database that came out of a bundle. Its schema is attacker-controlled, so views and
 * triggers may only call innocuous functions and every b-tree cell is bounds-checked.
 */
export function openUntrustedDb(file: string, options: { readonly?: boolean } = {}): Database.Database {
  const db = new Database(file, options.readonly ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
  db.pragma('trusted_schema = OFF');
  db.pragma('cell_size_check = ON');
  return db;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function readIfExists(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function realDir(dir: string): Promise<string | null> {
  try {
    const real = await fs.promises.realpath(dir);
    return (await fs.promises.stat(real)).isDirectory() ? real : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function fileItem(archivePath: string, content: Buffer, mode = 0o600): PackItem {
  return {
    meta: {
      path: archivePath,
      type: 'file',
      mode,
      uid: 0,
      gid: 0,
      mtime: Math.floor(Date.now() / 1000),
      size: content.length,
    },
    content,
  };
}

function dirItem(archivePath: string): PackItem {
  return {
    meta: {
      path: archivePath,
      type: 'dir',
      mode: 0o755,
      uid: 0,
      gid: 0,
      mtime: Math.floor(Date.now() / 1000),
      size: 0,
    },
  };
}

export async function createBundle(options: CreateBundleOptions): Promise<BundleManifest> {
  const { host, key, destFile } = options;
  const id = options.id ?? newBackupId();
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manager-backup-'));
  const partial = `${destFile}.partial`;
  const progress = { entries: 0, bytes: 0 };

  try {
    // 1. Snapshots first, so every size in the manifest is final.
    const dbSnapshot = path.join(work, 'v2.db');
    await host.snapshotCentralDb(dbSnapshot);
    options.onProgress?.({ phase: 'snapshot', ...progress });
    const snapshots = new Map<string, { source: string; size: number }>();
    let snapshotCount = 0;
    const substitute = async (
      rel: string,
      _stat: fs.Stats,
      full: string,
    ): Promise<{ source: string; size: number } | null> => {
      if (!SESSION_DB.test(rel)) return null;
      const copy = path.join(work, `session-${snapshotCount++}.db`);
      try {
        snapshotSqliteFile(full, copy);
      } catch (error) {
        throw new BundleError('source_unreadable', `cannot snapshot ${rel}: ${(error as Error).message}`);
      }
      const entry = { source: copy, size: (await fs.promises.stat(copy)).size };
      snapshots.set(rel, entry);
      return entry;
    };

    // 2. Collect every archive item (entries only, no content yet).
    const items: PackItem[] = [];
    items.push(dirItem('db'));
    const dbStat = await fs.promises.stat(dbSnapshot);
    items.push({
      meta: {
        path: 'db/v2.db',
        type: 'file',
        mode: 0o600,
        uid: 0,
        gid: 0,
        mtime: Math.floor(Date.now() / 1000),
        size: dbStat.size,
      },
      source: dbSnapshot,
    });

    const roots: Array<
      [string, string, ((rel: string, stat: fs.Stats) => boolean) | undefined, typeof substitute | undefined]
    > = [
      ['data', host.dataDir, includeInData, substitute],
      ['groups', host.groupsDir, includeOutsideTxn, undefined],
      ['store', host.storeDir, includeOutsideTxn, undefined],
    ];
    // Agents and containers write into these trees. Whatever a restore would refuse is left out
    // and reported, so one odd entry cannot make every later backup unrestorable.
    const skipped: string[] = [];
    for (const [prefix, dir, include, sub] of roots) {
      const real = await realDir(dir);
      if (!real) {
        items.push(dirItem(prefix));
        continue;
      }
      for await (const item of walkTree({
        root: real,
        prefix,
        include,
        substitute: sub,
        refuse: restorePolicyProblem,
        onSkip: (archivePath, reason) => skipped.push(`${archivePath} (${reason})`),
      }))
        items.push(item);
    }

    const env = readIfExists(host.envFile);
    items.push(dirItem('env'));
    if (env) items.push(fileItem('env/dotenv', env));

    items.push(dirItem('config'));
    items.push(dirItem('config/nanoclaw'));
    let machineIdentityIncluded = false;
    if (host.homeConfigDir) {
      const names = [...CONFIG_FILES, ...(options.includeMachineIdentity ? MACHINE_IDENTITY_FILES : [])];
      for (const name of names) {
        const content = readIfExists(path.join(host.homeConfigDir, name));
        if (!content) continue;
        items.push(fileItem(`config/nanoclaw/${name}`, content));
        if (MACHINE_IDENTITY_FILES.includes(name)) machineIdentityIncluded = true;
      }
    }

    // 3. Manifest first.
    const files = items.filter((item) => item.meta.type === 'file');
    const identity = host.identity();
    const manifest: BundleManifest = {
      schema: BUNDLE_SCHEMA,
      id,
      createdAt: new Date().toISOString(),
      tool: { name: 'manager-backup', version: TOOL_VERSION },
      source: { ...identity, installSlug: host.installSlug() },
      db: await host.describeDb(),
      installed: host.installed(),
      ...(await namesOrNothing(host)),
      contents: {
        entries: items.length + 1,
        files: files.length + 1,
        bytes: files.reduce((sum, item) => sum + item.meta.size, 0),
      },
      identities: { machineIdentityIncluded },
      consistency: options.consistency ?? 'best-effort',
      excluded: [
        ...EXCLUDED_DESCRIPTION,
        ...(skipped.length > 0
          ? [
              `${skipped.length} entries a restore would refuse: ${skipped.slice(0, MAX_SKIPPED_LISTED).join(', ')}${skipped.length > MAX_SKIPPED_LISTED ? ', ...' : ''}`,
            ]
          : []),
      ],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

    async function* everything(): AsyncGenerator<PackItem> {
      yield fileItem('manifest.json', manifestBytes);
      for (const item of items) {
        progress.entries++;
        progress.bytes += item.meta.size;
        if (progress.entries % 500 === 0) options.onProgress?.({ phase: 'pack', ...progress });
        yield item;
      }
    }

    // 4. tar -> gzip -> encrypt -> file
    await fs.promises.mkdir(path.dirname(destFile), { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(partial, { mode: 0o600, flags: 'wx' });
    await pipeline(
      Readable.from(
        packEntries(
          everything(),
          (options.consistency ?? 'best-effort') !== 'cold'
            ? (archivePath, how) => options.onChanged?.(archivePath, how)
            : undefined,
        ),
      ),
      zlib.createGzip({ level: options.gzipLevel ?? 3 }),
      async function* (source: AsyncIterable<Buffer>) {
        yield* encryptStream(source, key);
      },
      out,
    );
    const handle = await fs.promises.open(partial, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(partial, destFile);
    options.onProgress?.({ phase: 'pack', ...progress });
    return manifest;
  } catch (error) {
    await fs.promises.rm(partial, { force: true });
    throw error;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Decrypted, decompressed tar bytes of a bundle file. Errors surface while iterating. When the
 * consumer reads to the end, every ciphertext chunk has been authenticated, the last one included,
 * even if the gzip stream finished before the file did.
 */
export function openBundleStream(file: string, key: Buffer): Readable {
  return Readable.from(inflateAll(decryptStream(fs.createReadStream(file), key)));
}

async function* inflateAll(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const gunzip = zlib.createGunzip();
  let cancelled = false; // the consumer stopped early: stop reading the file
  let closed = false; // gunzip is done (it ignores anything after its stream, which is still read and authenticated)
  const closing = new Promise<void>((resolve) => {
    gunzip.once('close', () => {
      closed = true;
      resolve();
    });
  });
  const feeding = (async () => {
    for await (const chunk of source) {
      if (cancelled) break;
      if (!closed && !gunzip.write(chunk)) await Promise.race([once(gunzip, 'drain'), closing]);
    }
    if (!cancelled && !closed) gunzip.end();
  })();
  feeding.catch((error: unknown) => gunzip.destroy(error as Error));
  let completed = false;
  try {
    yield* gunzip;
    await feeding; // the file was read to its end: every chunk and the final tag are checked
    completed = true;
  } finally {
    if (!completed) cancelled = true;
    gunzip.destroy();
  }
}

/**
 * Names the packer never emits. A hand-made `-wal` next to a session or central database would be
 * applied by SQLite on first open, after the integrity check had looked at the main file only.
 */
function rejectMember(meta: TarEntryMeta): string | null {
  const [top, ...rest] = meta.path.split('/');
  const rel = rest.join('/');
  if (
    top === 'data' &&
    (SESSION_DB_SIDECAR.test(rel) || (rest.length === 1 && /^v2\.db-(?:wal|shm|journal)$/.test(rel)))
  )
    return 'database sidecar file in a bundle';
  if (top === 'db' && rest.length > 0 && (rel !== 'v2.db' || meta.type !== 'file'))
    return 'unexpected member under db/';
  return null;
}

export const BUNDLE_POLICY: MemberPolicy = {
  topLevel: TOP_LEVEL,
  rejectMember,
  allowSymlink: (member, target) => {
    if (target === '' || target.includes('\0')) return false;
    const top = member.split('/')[0];
    // Agent workspaces hold things like Python virtual environments whose links point outside the
    // tree (an interpreter in /usr/bin). They are recreated verbatim and nothing in a restore follows
    // them: the extractor refuses to write through any link, and the fix-ups that read the restored
    // tree (restore.ts) use lstat and never enter groups/ or store/ through a link.
    if (top === 'groups' || top === 'store') return true;
    // Only the data directory has legitimate links, and they stay inside it.
    if (top !== 'data') return false;
    // Container skill links point at /app/skills/..., dangling on the host by design.
    if (target.startsWith('/app/') && !target.includes('..')) return true;
    if (target.startsWith('/')) return false;
    if (hasInnerParentSegment(target)) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member), target));
    return resolved === top || resolved.startsWith(`${top}/`);
  },
};

/** Why restore would refuse an entry (so a backup leaves it out), or null. */
function restorePolicyProblem(meta: TarEntryMeta): string | null {
  const problem = memberPathProblem(meta.path);
  if (problem) return problem;
  if (meta.type === 'symlink' && !BUNDLE_POLICY.allowSymlink!(meta.path, meta.linkpath ?? ''))
    return 'link target outside the tree';
  return BUNDLE_POLICY.rejectMember?.(meta) ?? null;
}

/** Caps for reading a bundle whose manifest is known: what it declares, plus the manifest member itself. */
export function bundleLimits(manifest: BundleManifest): ExtractLimits {
  return { entries: manifest.contents.entries, bytes: manifest.contents.bytes + MAX_MANIFEST_BYTES };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseManifest(raw: unknown): BundleManifest {
  if (!isRecord(raw)) throw new BundleError('bad_manifest', 'manifest is not an object');
  if (raw.schema !== BUNDLE_SCHEMA)
    throw new BundleError('unsupported_schema', `unsupported bundle schema ${JSON.stringify(raw.schema)}`);
  const need = (cond: boolean, what: string): void => {
    if (!cond) throw new BundleError('bad_manifest', `manifest field ${what} is missing or invalid`);
  };
  const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
  need(str(raw.id), 'id');
  need(str(raw.createdAt), 'createdAt');
  need(
    isRecord(raw.source) &&
      str(raw.source.version) &&
      str(raw.source.commit) &&
      str(raw.source.tree) &&
      str(raw.source.installSlug),
    'source',
  );
  need(
    isRecord(raw.db) &&
      str(raw.db.dialect) &&
      Array.isArray(raw.db.migrations) &&
      raw.db.migrations.every((m) => typeof m === 'string'),
    'db',
  );
  need(isRecord(raw.db) && isRecord(raw.db.counts), 'db.counts');
  need(
    isRecord(raw.installed) &&
      ['channels', 'providers', 'containerProviders', 'modules'].every((k) =>
        Array.isArray((raw.installed as Record<string, unknown>)[k]),
      ),
    'installed',
  );
  need(
    isRecord(raw.contents) &&
      ['entries', 'files', 'bytes'].every((k) => {
        const value = (raw.contents as Record<string, unknown>)[k];
        return Number.isSafeInteger(value) && (value as number) >= 0;
      }),
    'contents',
  );
  need(
    raw.gatewayCredentials === undefined ||
      (Array.isArray(raw.gatewayCredentials) && raw.gatewayCredentials.every((name) => typeof name === 'string')),
    'gatewayCredentials',
  );
  need(isRecord(raw.identities), 'identities');
  need(
    raw.consistency === 'cold' || raw.consistency === 'quiescent' || raw.consistency === 'best-effort',
    'consistency',
  );
  return raw as unknown as BundleManifest;
}

async function readAll(body: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of body) {
    size += part.length;
    if (size > limit) throw new BundleError('bad_manifest', 'manifest is too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** Read only the manifest (the first member). Needs the key: the manifest is encrypted. */
export async function readManifest(file: string, key: Buffer): Promise<BundleManifest> {
  const stream = openBundleStream(file, key);
  const entries = readTar(stream);
  try {
    const first = await entries.next();
    if (first.done || first.value.meta.path !== 'manifest.json' || first.value.meta.type !== 'file') {
      throw new BundleError('missing_member', 'bundle does not start with manifest.json');
    }
    const bytes = await readAll(first.value.body, MAX_MANIFEST_BYTES);
    try {
      return parseManifest(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof BundleError) throw error;
      throw new BundleError('bad_manifest', 'manifest is not valid JSON');
    }
  } finally {
    stream.destroy();
    await entries.return(undefined);
  }
}

export interface VerifyResult {
  manifest: BundleManifest;
  entries: number;
  files: number;
  /** Regular-file content, manifest member excluded (equals `manifest.contents.bytes`). */
  bytes: number;
  /** The same bytes per top-level member, to size the staging areas. */
  byTop: Record<string, number>;
}

function parseManifestBytes(bytes: Buffer): BundleManifest {
  try {
    return parseManifest(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof BundleError) throw error;
    throw new BundleError('bad_manifest', 'manifest is not valid JSON');
  }
}

/** Free bytes on the filesystem holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const stats = await fs.promises.statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Read the whole bundle: authenticate every byte, validate every member against
 * the policy, compare counts with the manifest and run an integrity check on
 * the database snapshots. Nothing is written outside a private temp directory.
 *
 * The manifest is read and validated first; from then on the headers are held to what it declares
 * (entries, files, bytes), so a hostile size or entry count aborts the stream before anything is
 * written, and the database snapshots written for the integrity check are bounded by free space.
 */
export async function verifyBundle(file: string, key: Buffer): Promise<VerifyResult> {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manager-backup-verify-'));
  try {
    const checker = new MemberChecker(BUNDLE_POLICY);
    let manifest: BundleManifest | null = null;
    let entries = 0;
    let files = 0;
    let bytes = 0;
    const byTop: Record<string, number> = {};
    let sawDb = false;
    const sqliteChecks: string[] = [];

    for await (const entry of readTar(openBundleStream(file, key))) {
      const meta: TarEntryMeta = entry.meta;
      checker.check(meta);
      entries++;
      if (entries === 1) {
        if (meta.path !== 'manifest.json' || meta.type !== 'file')
          throw new BundleError('missing_member', 'bundle does not start with manifest.json');
        files++;
        manifest = parseManifestBytes(await readAll(entry.body, MAX_MANIFEST_BYTES));
        checker.limits = { entries: manifest.contents.entries, bytes: manifest.contents.bytes + meta.size };
        continue;
      }
      if (meta.type === 'file') {
        files++;
        bytes += meta.size;
        const top = meta.path.split('/')[0];
        byTop[top] = (byTop[top] ?? 0) + meta.size;
      }
      if (manifest && (files > manifest.contents.files || bytes > manifest.contents.bytes))
        throw new BundleError('limit_exceeded', 'the bundle holds more files or bytes than its manifest declares');
      const isDb =
        meta.type === 'file' && (meta.path === 'db/v2.db' || SESSION_DB.test(meta.path.replace(/^data\//, '')));
      if (isDb) {
        if ((await freeBytes(work)) < meta.size + SPACE_MARGIN)
          throw new BundleError(
            'insufficient_space',
            'not enough free space in the temp directory to check the databases',
          );
        const target = path.join(work, `check-${sqliteChecks.length}.db`);
        const out = fs.createWriteStream(target, { mode: 0o600 });
        await pipeline(Readable.from(entry.body), out);
        sqliteChecks.push(target);
        if (meta.path === 'db/v2.db') sawDb = true;
        continue;
      }
      await entry.skip();
    }

    if (!manifest) throw new BundleError('missing_member', 'bundle is empty');
    if (!sawDb) throw new BundleError('missing_member', 'bundle has no db/v2.db');
    // The manifest counts itself as an entry and a file; its bytes are not in `contents.bytes`.
    if (
      entries !== manifest.contents.entries ||
      files !== manifest.contents.files ||
      bytes !== manifest.contents.bytes
    ) {
      throw new BundleError(
        'count_mismatch',
        `manifest lists ${manifest.contents.entries} entries / ${manifest.contents.files} files / ${manifest.contents.bytes} bytes but the bundle has ${entries} / ${files} / ${bytes}`,
      );
    }
    for (const target of sqliteChecks) {
      const db = openUntrustedDb(target, { readonly: true });
      try {
        const result = db.pragma('integrity_check', { simple: true });
        if (result !== 'ok')
          throw new BundleError(
            'database_check_failed',
            `a database snapshot failed its integrity check: ${String(result)}`,
          );
      } finally {
        db.close();
      }
    }
    return { manifest, entries, files, bytes, byTop };
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

export { CryptoError };
