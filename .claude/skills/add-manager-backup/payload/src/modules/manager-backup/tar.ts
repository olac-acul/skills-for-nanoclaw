/**
 * Minimal tar archive writer, reader and safe extractor for backup bundles.
 *
 * Deliberately small: ustar headers plus PAX extended records, and nothing
 * else. It only has to read what `packTree` writes, so the reader refuses
 * every feature the writer never emits (GNU long names, sparse files, devices,
 * global PAX headers) instead of trying to interpret it.
 *
 * Entry types: regular file, directory, symlink, hardlink. Numeric uid/gid are
 * stored in the headers (no name lookup) so a restore on another machine keeps
 * ownership by number.
 */
import fs from 'node:fs';
import path from 'node:path';

const BLOCK = 512;
const MAX_PAX_BYTES = 1024 * 1024;
const OCTAL_7 = 0o7777777; // 7 octal digits (uid/gid fields)
const OCTAL_11 = 0o77777777777; // 11 octal digits (size/mtime fields)

export type TarEntryType = 'file' | 'dir' | 'symlink' | 'hardlink';

export interface TarEntryMeta {
  /** Slash-separated, relative, no `..` segments. Directories carry no trailing slash. */
  path: string;
  type: TarEntryType;
  mode: number;
  uid: number;
  gid: number;
  /** Whole seconds since the epoch. */
  mtime: number;
  /** Bytes of content; 0 for everything but regular files. */
  size: number;
  /** Target for symlinks (verbatim, may dangle) and hardlinks (archive path). */
  linkpath?: string;
}

export class TarError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TarError';
  }
}

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

const TYPE_FLAG: Record<TarEntryType, string> = { file: '0', dir: '5', symlink: '2', hardlink: '1' };
const FLAG_TYPE = new Map<string, TarEntryType>([
  ['0', 'file'],
  ['\0', 'file'],
  ['5', 'dir'],
  ['2', 'symlink'],
  ['1', 'hardlink'],
]);

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  if (digits.length > length - 1)
    throw new TarError('field_overflow', `value ${value} does not fit ${length - 1} octal digits`);
  buf.write(digits, offset, 'ascii');
  buf[offset + length - 1] = 0;
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/** Split into ustar (prefix, name) if it fits, else null. */
function splitUstarPath(p: string): { prefix: string; name: string } | null {
  if (!isAscii(p)) return null;
  if (Buffer.byteLength(p) <= 100) return { prefix: '', name: p };
  for (let i = p.length - 1; i > 0; i--) {
    if (p[i] !== '/') continue;
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (name.length > 0 && name.length <= 100 && prefix.length <= 155) return { prefix, name };
  }
  return null;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let total = bodyLen + String(bodyLen).length;
  if (String(total).length !== String(bodyLen).length) total = bodyLen + String(total).length;
  return Buffer.from(`${total}${body}`);
}

function buildHeader(opts: {
  name: string;
  prefix?: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  flag: string;
  linkname?: string;
}): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(opts.name, 0, 100, 'ascii');
  writeOctal(header, 100, 8, opts.mode & 0o7777);
  writeOctal(header, 108, 8, opts.uid);
  writeOctal(header, 116, 8, opts.gid);
  writeOctal(header, 124, 12, opts.size);
  writeOctal(header, 136, 12, opts.mtime);
  header.fill(0x20, 148, 156); // checksum placeholder
  header.write(opts.flag, 156, 1, 'ascii');
  if (opts.linkname) header.write(opts.linkname, 157, 100, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  if (opts.prefix) header.write(opts.prefix, 345, 155, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/** Header blocks (including a PAX extension when needed) for one entry. */
export function encodeEntryHeader(meta: TarEntryMeta): Buffer {
  const records: Buffer[] = [];
  const split = splitUstarPath(meta.path);
  if (!split) records.push(paxRecord('path', meta.path));
  const linkpath = meta.linkpath ?? '';
  if (linkpath && (!isAscii(linkpath) || Buffer.byteLength(linkpath) > 100))
    records.push(paxRecord('linkpath', linkpath));
  if (meta.uid > OCTAL_7) records.push(paxRecord('uid', String(meta.uid)));
  if (meta.gid > OCTAL_7) records.push(paxRecord('gid', String(meta.gid)));
  if (meta.size > OCTAL_11) records.push(paxRecord('size', String(meta.size)));
  const inline = {
    name: split?.name ?? 'pax-long-name',
    prefix: split?.prefix ?? '',
    linkname: linkpath && isAscii(linkpath) && Buffer.byteLength(linkpath) <= 100 ? linkpath : undefined,
  };
  const main = buildHeader({
    name: inline.name,
    prefix: inline.prefix,
    mode: meta.mode,
    uid: Math.min(meta.uid, OCTAL_7),
    gid: Math.min(meta.gid, OCTAL_7),
    size: Math.min(meta.size, OCTAL_11),
    mtime: Math.min(Math.max(meta.mtime, 0), OCTAL_11),
    flag: TYPE_FLAG[meta.type],
    linkname: inline.linkname,
  });
  if (records.length === 0) return main;
  const data = Buffer.concat(records);
  const pax = buildHeader({ name: 'pax-header', mode: 0o644, uid: 0, gid: 0, size: data.length, mtime: 0, flag: 'x' });
  return Buffer.concat([pax, data, padding(data.length), main]);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PackItem {
  meta: TarEntryMeta;
  /** Absolute source path for regular files; read exactly `meta.size` bytes. */
  source?: string;
  /** Small in-memory content for regular files (takes precedence over `source`). */
  content?: Buffer;
}

const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2);

/** Serialise entries into a tar byte stream. */
export async function* packEntries(items: AsyncIterable<PackItem> | Iterable<PackItem>): AsyncGenerator<Buffer> {
  for await (const item of items as AsyncIterable<PackItem>) {
    yield encodeEntryHeader(item.meta);
    if (item.meta.type !== 'file' || item.meta.size === 0) continue;
    if (item.content) {
      if (item.content.length !== item.meta.size)
        throw new TarError('size_mismatch', `${item.meta.path} content length differs from its header`);
      yield item.content;
    } else if (item.source) {
      yield* readExactly(item.source, item.meta.size, item.meta.path);
    } else {
      throw new TarError('missing_source', `no source for ${item.meta.path}`);
    }
    yield padding(item.meta.size);
  }
  yield END_OF_ARCHIVE;
}

async function* readExactly(file: string, size: number, label: string): AsyncGenerator<Buffer> {
  const handle = await fs.promises.open(file, 'r');
  try {
    let remaining = size;
    const chunk = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
    let position = 0;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), position);
      if (bytesRead === 0) throw new TarError('file_changed', `${label} shrank while being archived`);
      yield Buffer.from(chunk.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

export interface WalkOptions {
  /** Directory to archive. */
  root: string;
  /** Path prefix inside the archive (one or more segments). */
  prefix: string;
  /** Return false to leave an entry (and, for a directory, everything below it) out. */
  include?: (relativePath: string, stat: fs.Stats) => boolean;
  /**
   * Replace the content of a regular file, e.g. with a consistent snapshot of a
   * live SQLite database. Return null to archive the file as it is.
   */
  substitute?: (
    relativePath: string,
    stat: fs.Stats,
    fullPath: string,
  ) => Promise<{ source: string; size: number } | null>;
}

/**
 * Walk a directory tree depth-first in sorted order and yield archive items.
 * Hard-linked regular files after the first become `hardlink` entries.
 * Sockets, FIFOs and devices are skipped.
 */
export async function* walkTree(options: WalkOptions): AsyncGenerator<PackItem> {
  const seen = new Map<string, string>(); // "dev:ino" -> archive path of the first occurrence
  const base = options.prefix.replace(/\/+$/, '');

  async function* visit(dir: string, relative: string): AsyncGenerator<PackItem> {
    const names = (await fs.promises.readdir(dir)).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = await fs.promises.lstat(full);
      if (options.include && !options.include(rel, stat)) continue;
      const archivePath = `${base}/${rel}`;
      const common = { mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, mtime: Math.floor(stat.mtimeMs / 1000) };
      if (stat.isSymbolicLink()) {
        yield {
          meta: { ...common, path: archivePath, type: 'symlink', size: 0, linkpath: await fs.promises.readlink(full) },
        };
      } else if (stat.isDirectory()) {
        yield { meta: { ...common, path: archivePath, type: 'dir', size: 0 } };
        yield* visit(full, rel);
      } else if (stat.isFile()) {
        const key = `${stat.dev}:${stat.ino}`;
        const first = stat.nlink > 1 ? seen.get(key) : undefined;
        if (first) {
          yield { meta: { ...common, path: archivePath, type: 'hardlink', size: 0, linkpath: first } };
        } else {
          if (stat.nlink > 1) seen.set(key, archivePath);
          const replaced = options.substitute ? await options.substitute(rel, stat, full) : null;
          yield {
            meta: { ...common, path: archivePath, type: 'file', size: replaced?.size ?? stat.size },
            source: replaced?.source ?? full,
          };
        }
      }
    }
  }

  const rootStat = await fs.promises.lstat(options.root);
  // Multi-segment prefixes need their ancestors as explicit directory entries.
  const segments = base.split('/');
  for (let i = 1; i < segments.length; i++) {
    yield {
      meta: {
        path: segments.slice(0, i).join('/'),
        type: 'dir',
        mode: 0o755,
        uid: rootStat.uid,
        gid: rootStat.gid,
        mtime: Math.floor(rootStat.mtimeMs / 1000),
        size: 0,
      },
    };
  }
  yield {
    meta: {
      path: base,
      type: 'dir',
      mode: rootStat.mode & 0o7777,
      uid: rootStat.uid,
      gid: rootStat.gid,
      mtime: Math.floor(rootStat.mtimeMs / 1000),
      size: 0,
    },
  };
  yield* visit(options.root, '');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Pull-based byte reader over an async iterable of chunks. */
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private done = false;
  private iterator: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(min: number): Promise<void> {
    while (this.buffered < min && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
  }

  /** Read exactly `n` bytes, or fewer only at end of input. */
  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    const take = Math.min(n, this.buffered);
    const out = Buffer.allocUnsafe(take);
    let offset = 0;
    while (offset < take) {
      const head = this.chunks[0];
      const want = take - offset;
      if (head.length <= want) {
        head.copy(out, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, offset, 0, want);
        this.chunks[0] = head.subarray(want);
        offset += want;
      }
    }
    this.buffered -= take;
    return out;
  }

  /** Read up to `n` bytes without waiting for more than one chunk. */
  async readSome(n: number): Promise<Buffer> {
    if (this.buffered === 0) await this.fill(1);
    if (this.buffered === 0) return Buffer.alloc(0);
    const head = this.chunks[0];
    const take = Math.min(n, head.length);
    const out = Buffer.from(head.subarray(0, take));
    if (take === head.length) this.chunks.shift();
    else this.chunks[0] = head.subarray(take);
    this.buffered -= take;
    return out;
  }
}

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('latin1');
}

function readOctal(buf: Buffer, offset: number, length: number, field: string): number {
  const text = readString(buf, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError('bad_header', `invalid octal in ${field}`);
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = readOctal(header, 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === stored;
}

function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new TarError('bad_pax', 'malformed PAX record');
    const length = Number(data.toString('ascii', pos, space));
    if (!Number.isInteger(length) || length <= space - pos + 1 || pos + length > data.length) {
      throw new TarError('bad_pax', 'malformed PAX record length');
    }
    const body = data.toString('utf8', space + 1, pos + length - 1);
    const eq = body.indexOf('=');
    if (eq === -1) throw new TarError('bad_pax', 'PAX record without a value');
    records.set(body.slice(0, eq), body.slice(eq + 1));
    pos += length;
  }
  return records;
}

function paxNumber(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,16}$/.test(value)) throw new TarError('bad_pax', `invalid PAX ${field}`);
  return Number(value);
}

export interface TarEntry {
  meta: TarEntryMeta;
  /** Content of a regular file. Must be fully consumed (or `skip()`ped) before the next entry. */
  body: AsyncGenerator<Buffer>;
  skip(): Promise<void>;
}

/** Parse a tar byte stream. Throws `TarError` on anything outside the supported subset. */
export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source);
  let pending: Map<string, string> | null = null;
  let sawEnd = false;

  for (;;) {
    const header = await reader.read(BLOCK);
    if (header.length === 0) break; // clean end without terminator blocks
    if (header.length < BLOCK) throw new TarError('truncated', 'archive ends inside a header');
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    if (!checksumOk(header)) throw new TarError('bad_checksum', 'header checksum mismatch');

    const flag = String.fromCharCode(header[156]);
    const size = readOctal(header, 124, 12, 'size');

    if (flag === 'x') {
      if (size > MAX_PAX_BYTES) throw new TarError('bad_pax', 'PAX header too large');
      const data = await reader.read(size);
      if (data.length < size) throw new TarError('truncated', 'archive ends inside a PAX header');
      await reader.read(padding(size).length);
      pending = parsePax(data);
      continue;
    }
    const type = FLAG_TYPE.get(flag);
    if (!type) throw new TarError('unsupported_type', `unsupported entry type ${JSON.stringify(flag)}`);

    const pax = pending ?? new Map<string, string>();
    pending = null;
    const prefix = readString(header, 345, 155);
    const inlineName = readString(header, 0, 100);
    const entryPath = pax.get('path') ?? (prefix ? `${prefix}/${inlineName}` : inlineName);
    const linkpath = pax.get('linkpath') ?? readString(header, 157, 100);
    const meta: TarEntryMeta = {
      path: entryPath,
      type,
      mode: readOctal(header, 100, 8, 'mode'),
      uid: paxNumber(pax.get('uid'), 'uid') ?? readOctal(header, 108, 8, 'uid'),
      gid: paxNumber(pax.get('gid'), 'gid') ?? readOctal(header, 116, 8, 'gid'),
      mtime: readOctal(header, 136, 12, 'mtime'),
      size: type === 'file' ? (paxNumber(pax.get('size'), 'size') ?? size) : 0,
      linkpath: type === 'symlink' || type === 'hardlink' ? linkpath : undefined,
    };
    if (type !== 'file' && size !== 0) throw new TarError('bad_header', `${type} entry with a body`);

    let consumed = false;
    async function* body(): AsyncGenerator<Buffer> {
      consumed = true;
      let remaining = meta.size;
      while (remaining > 0) {
        const chunk = await reader.readSome(Math.min(remaining, 1024 * 1024));
        if (chunk.length === 0) throw new TarError('truncated', `archive ends inside ${meta.path}`);
        remaining -= chunk.length;
        yield chunk;
      }
      await reader.read(padding(meta.size).length);
    }
    const iterator = body();
    yield {
      meta,
      body: iterator,
      skip: async () => {
        for await (const chunk of iterator) void chunk;
      },
    };
    if (!consumed) {
      // The caller ignored the body entirely: skip it so the stream stays aligned.
      for await (const chunk of iterator) void chunk;
    }
  }
  if (!sawEnd) {
    // Accept a stream that stops exactly at an entry boundary, nothing more.
    return;
  }
}

// ---------------------------------------------------------------------------
// Validation and extraction
// ---------------------------------------------------------------------------

export interface MemberPolicy {
  /** Allowed top-level archive members (first path segment). */
  topLevel: ReadonlySet<string>;
  /**
   * Decide whether a symlink is acceptable. `memberPath` is the archive path of
   * the link; `target` is its verbatim target. Default: only targets that stay
   * inside the same top-level member and are relative.
   */
  allowSymlink?: (memberPath: string, target: string) => boolean;
}

export function defaultAllowSymlink(memberPath: string, target: string): boolean {
  if (target === '' || target.startsWith('/') || target.includes('\0')) return false;
  const dir = path.posix.dirname(memberPath);
  const resolved = path.posix.normalize(path.posix.join(dir, target));
  const top = memberPath.split('/')[0];
  return resolved === top || resolved.startsWith(`${top}/`);
}

function checkMemberPath(p: string): void {
  if (p === '' || p.startsWith('/') || p.includes('\0') || p.includes('\\')) {
    throw new TarError('unsafe_member', `unsafe member path ${JSON.stringify(p)}`);
  }
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TarError('unsafe_member', `unsafe member path ${JSON.stringify(p)}`);
    }
  }
}

/** Stateful per-archive checker: paths, duplicates, link rules. */
export class MemberChecker {
  private readonly files = new Set<string>();
  private readonly all = new Set<string>();

  constructor(private readonly policy: MemberPolicy) {}

  check(meta: TarEntryMeta): void {
    checkMemberPath(meta.path);
    const top = meta.path.split('/')[0];
    if (!this.policy.topLevel.has(top))
      throw new TarError('unsafe_member', `unexpected top-level member ${JSON.stringify(top)}`);
    if (this.all.has(meta.path))
      throw new TarError('duplicate_member', `duplicate member ${JSON.stringify(meta.path)}`);
    this.all.add(meta.path);

    if (meta.type === 'symlink') {
      const allow = this.policy.allowSymlink ?? defaultAllowSymlink;
      if (!allow(meta.path, meta.linkpath ?? '')) {
        throw new TarError('unsafe_symlink', `symlink ${JSON.stringify(meta.path)} has a disallowed target`);
      }
    } else if (meta.type === 'hardlink') {
      const target = meta.linkpath ?? '';
      checkMemberPath(target);
      if (target.split('/')[0] !== top || !this.files.has(target)) {
        throw new TarError(
          'unsafe_hardlink',
          `hardlink ${JSON.stringify(meta.path)} must point to an earlier file in the same member`,
        );
      }
    } else if (meta.type === 'file') {
      this.files.add(meta.path);
    }
  }
}

export interface ExtractOptions {
  policy: MemberPolicy;
  /** Apply owners from the archive. Needs root; otherwise ownership is left to the caller. */
  preserveOwner?: boolean;
  /** Called for every extracted entry (progress, auditing). */
  onEntry?: (meta: TarEntryMeta) => void;
}

export interface ExtractResult {
  entries: number;
  files: number;
  bytes: number;
  /** True when ownership was applied (root with `preserveOwner`). */
  ownersApplied: boolean;
}

/** Remove setuid/setgid/sticky and group/other write bits. */
export function sanitizeMode(mode: number, type: TarEntryType): number {
  const safe = mode & 0o755;
  return type === 'dir' ? safe | 0o700 : safe | 0o400;
}

async function assertRealDirectoryChain(root: string, relative: string): Promise<void> {
  // Every existing ancestor of the target must be a real directory, never a symlink.
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory())
      throw new TarError('unsafe_member', `${parts.slice(0, i + 1).join('/')} is not a plain directory`);
  }
}

/** Extract a bundle into `destRoot` (which must exist). */
export async function extractTar(
  source: AsyncIterable<Buffer>,
  destRoot: string,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const checker = new MemberChecker(options.policy);
  const applyOwner = options.preserveOwner === true && typeof process.getuid === 'function' && process.getuid() === 0;
  const result: ExtractResult = { entries: 0, files: 0, bytes: 0, ownersApplied: applyOwner };
  const deferredDirs: TarEntryMeta[] = [];

  for await (const entry of readTar(source)) {
    const { meta } = entry;
    checker.check(meta);
    await assertRealDirectoryChain(destRoot, meta.path);
    const target = path.join(destRoot, ...meta.path.split('/'));
    if (meta.path.includes('/')) {
      // The packer always writes ancestors first; a missing parent means a damaged or hostile archive.
      const parent = await fs.promises.lstat(path.dirname(target)).catch(() => null);
      if (!parent?.isDirectory())
        throw new TarError('missing_parent', `parent directory of ${meta.path} was not in the archive`);
    }

    if (meta.type === 'dir') {
      await fs.promises.mkdir(target, { recursive: false, mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        if (!(await fs.promises.lstat(target)).isDirectory())
          throw new TarError('unsafe_member', `${meta.path} exists and is not a directory`);
      });
      deferredDirs.push(meta);
    } else if (meta.type === 'file') {
      const handle = await fs.promises.open(target, 'wx', 0o600);
      try {
        for await (const chunk of entry.body) {
          await handle.write(chunk);
          result.bytes += chunk.length;
        }
        await handle.chmod(sanitizeMode(meta.mode, 'file'));
        if (applyOwner) await handle.chown(meta.uid, meta.gid);
      } finally {
        await handle.close();
      }
      await fs.promises.utimes(target, meta.mtime, meta.mtime);
      result.files++;
    } else if (meta.type === 'symlink') {
      await fs.promises.symlink(meta.linkpath ?? '', target);
      if (applyOwner) await fs.promises.lchown(target, meta.uid, meta.gid);
    } else {
      await fs.promises.link(path.join(destRoot, ...(meta.linkpath ?? '').split('/')), target);
    }
    result.entries++;
    options.onEntry?.(meta);
  }

  // Directory modes, owners and times last, deepest first, so restrictive modes
  // cannot block extraction of their own contents.
  for (const meta of deferredDirs.sort((a, b) => b.path.length - a.path.length)) {
    const target = path.join(destRoot, ...meta.path.split('/'));
    await fs.promises.chmod(target, sanitizeMode(meta.mode, 'dir'));
    if (applyOwner) await fs.promises.chown(target, meta.uid, meta.gid);
    await fs.promises.utimes(target, meta.mtime, meta.mtime);
  }
  return result;
}
