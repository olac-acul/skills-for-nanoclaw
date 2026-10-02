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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';

import { CryptoError, decryptStream, encryptStream } from './crypto.js';
import type { BackupHost, DbDescription, InstalledInventory } from './host.js';
import {
  MemberChecker,
  packEntries,
  readTar,
  walkTree,
  type MemberPolicy,
  type PackItem,
  type TarEntryMeta,
} from './tar.js';

export const BUNDLE_SCHEMA = 'manager-backup/v1';
export const TOOL_VERSION = '0.1.0';
/** Scratch directory a restore keeps inside each root it replaces; never archived. */
export const TXN_DIR = '.manager-backup-txn';
export const TOP_LEVEL = new Set(['manifest.json', 'db', 'data', 'groups', 'store', 'env', 'config']);
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** Files that identify this machine rather than the install; only backed up on request. */
export const MACHINE_IDENTITY_FILES = ['device-key.json', 'account.json', 'host-id'];
const CONFIG_FILES = ['mount-allowlist.json', 'sender-allowlist.json'];

export class BundleError extends Error {
  constructor(
    readonly code:
      | 'bad_manifest'
      | 'unsupported_schema'
      | 'missing_member'
      | 'count_mismatch'
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
const TOP_LEVEL_EXCLUDES = new Set(['v2.db', 'v2.db-wal', 'v2.db-shm', 'v2.db-journal', 'circuit-breaker.json']);

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
    for (const [prefix, dir, include, sub] of roots) {
      const real = await realDir(dir);
      if (!real) {
        items.push(dirItem(prefix));
        continue;
      }
      for await (const item of walkTree({ root: real, prefix, include, substitute: sub })) items.push(item);
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
      contents: {
        entries: items.length + 1,
        files: files.length + 1,
        bytes: files.reduce((sum, item) => sum + item.meta.size, 0),
      },
      identities: { machineIdentityIncluded },
      consistency: options.consistency ?? 'best-effort',
      excluded: EXCLUDED_DESCRIPTION,
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
      Readable.from(packEntries(everything())),
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

/** Decrypted, decompressed tar bytes of a bundle file. Errors surface while iterating. */
export function openBundleStream(file: string, key: Buffer): Readable {
  const decrypted = Readable.from(decryptStream(fs.createReadStream(file), key));
  const gunzip = zlib.createGunzip();
  decrypted.on('error', (error) => gunzip.destroy(error));
  gunzip.on('error', () => decrypted.destroy());
  gunzip.on('close', () => decrypted.destroy());
  return decrypted.pipe(gunzip);
}

export const BUNDLE_POLICY: MemberPolicy = {
  topLevel: TOP_LEVEL,
  allowSymlink: (member, target) => {
    // Container skill links point at /app/skills/..., dangling on the host by design.
    if (target.startsWith('/app/') && !target.includes('..') && !target.includes('\0')) return true;
    if (target.startsWith('/') || target === '') return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member), target));
    const top = member.split('/')[0];
    return resolved === top || resolved.startsWith(`${top}/`);
  },
};

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
      ['entries', 'files', 'bytes'].every((k) => Number.isInteger((raw.contents as Record<string, unknown>)[k])),
    'contents',
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
  bytes: number;
}

/**
 * Read the whole bundle: authenticate every byte, validate every member against
 * the policy, compare counts with the manifest and run an integrity check on
 * the database snapshots. Nothing is written outside a private temp directory.
 */
export async function verifyBundle(file: string, key: Buffer): Promise<VerifyResult> {
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manager-backup-verify-'));
  try {
    const checker = new MemberChecker(BUNDLE_POLICY);
    let manifest: BundleManifest | null = null;
    let entries = 0;
    let files = 0;
    let bytes = 0;
    let sawDb = false;
    const sqliteChecks: string[] = [];

    for await (const entry of readTar(openBundleStream(file, key))) {
      const meta: TarEntryMeta = entry.meta;
      checker.check(meta);
      entries++;
      if (meta.type === 'file') {
        files++;
        bytes += meta.size;
      }
      if (entries === 1) {
        if (meta.path !== 'manifest.json')
          throw new BundleError('missing_member', 'bundle does not start with manifest.json');
        manifest = parseManifest(JSON.parse((await readAll(entry.body, MAX_MANIFEST_BYTES)).toString('utf8')));
        continue;
      }
      const isDb =
        meta.type === 'file' && (meta.path === 'db/v2.db' || SESSION_DB.test(meta.path.replace(/^data\//, '')));
      if (isDb) {
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
    // The manifest counts itself; it was counted above as an entry and a file.
    if (entries !== manifest.contents.entries || files !== manifest.contents.files) {
      throw new BundleError(
        'count_mismatch',
        `manifest lists ${manifest.contents.entries} entries / ${manifest.contents.files} files but the bundle has ${entries} / ${files}`,
      );
    }
    for (const target of sqliteChecks) {
      const db = new Database(target, { readonly: true });
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
    return { manifest, entries, files, bytes };
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

export { CryptoError };
