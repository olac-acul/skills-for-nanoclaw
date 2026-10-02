import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TarError,
  encodeEntryHeader,
  extractTar,
  packEntries,
  readTar,
  walkTree,
  type MemberPolicy,
  type PackItem,
  type TarEntryMeta,
} from './tar.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-tar-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

function meta(overrides: Partial<TarEntryMeta> & { path: string }): TarEntryMeta {
  return { type: 'file', mode: 0o644, uid: 1000, gid: 1000, mtime: 1_700_000_000, size: 0, ...overrides };
}

async function archiveOf(items: PackItem[]): Promise<Buffer> {
  async function* gen(): AsyncGenerator<PackItem> {
    for (const item of items) yield item;
  }
  return collect(packEntries(gen()));
}

function resetChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
}

const policy: MemberPolicy = {
  topLevel: new Set(['state']),
  allowSymlink: (_member, target) => target.startsWith('/app/') || !target.startsWith('/'),
};

function buildTree(root: string): void {
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.chmodSync(path.join(root, 'a.txt'), 0o600);
  fs.writeFileSync(path.join(root, 'empty'), '');
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  fs.linkSync(path.join(root, 'a.txt'), path.join(root, 'sub', 'hard.txt'));
  fs.symlinkSync('/app/skills/foo', path.join(root, 'skill-link')); // dangling on the host by design
  fs.symlinkSync('sub/deeper', path.join(root, 'rel-link'));
  fs.writeFileSync(path.join(root, 'big.bin'), crypto.randomBytes(3 * 1024 * 1024 + 17));
  const longName = 'n'.repeat(90);
  const longDir = path.join(root, 'sub', longName, longName);
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(path.join(longDir, `${longName}.txt`), 'long path');
  fs.writeFileSync(path.join(root, 'sub', 'naïve-файл.txt'), 'unicode');
}

describe('round trip', () => {
  it('preserves content, modes, symlinks, hardlinks and long or non-ASCII names', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    buildTree(src);
    const bundle = await collect(packEntries(walkTree({ root: src, prefix: 'state/data' })));

    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest);
    const result = await extractTar(chunked(bundle, 4093), dest, { policy });
    expect(result.files).toBe(6);

    const out = path.join(dest, 'state', 'data');
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(out, 'big.bin')).equals(fs.readFileSync(path.join(src, 'big.bin')))).toBe(true);
    expect(fs.statSync(path.join(out, 'empty')).size).toBe(0);
    expect(fs.statSync(path.join(out, 'a.txt')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(out, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(out, 'skill-link'))).toBe('/app/skills/foo');
    expect(fs.readlinkSync(path.join(out, 'rel-link'))).toBe('sub/deeper');
    expect(fs.statSync(path.join(out, 'a.txt')).ino).toBe(fs.statSync(path.join(out, 'sub', 'hard.txt')).ino);
    expect(fs.readFileSync(path.join(out, 'sub', 'naïve-файл.txt'), 'utf8')).toBe('unicode');
    const longName = 'n'.repeat(90);
    expect(fs.readFileSync(path.join(out, 'sub', longName, longName, `${longName}.txt`), 'utf8')).toBe('long path');
  });

  it('survives one-byte input chunks', async () => {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'f'), 'x'.repeat(1500));
    const bundle = await collect(packEntries(walkTree({ root: src, prefix: 'state' })));
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest);
    await extractTar(chunked(bundle, 1), dest, { policy });
    expect(fs.readFileSync(path.join(dest, 'state', 'f'), 'utf8')).toBe('x'.repeat(1500));
  });

  it('is readable by the system tar', async () => {
    if (spawnSync('tar', ['--version']).status !== 0) return;
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    buildTree(src);
    const bundle = await collect(packEntries(walkTree({ root: src, prefix: 'state/data' })));
    const listing = spawnSync('tar', ['-tvf', '-'], { input: bundle, encoding: 'utf8' });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain('state/data/a.txt');
    expect(listing.stdout).toContain('skill-link -> /app/skills/foo');
    const longName = 'n'.repeat(90);
    expect(listing.stdout).toContain(`${longName}.txt`);
  });

  it('carries numeric owners beyond the ustar range through PAX records', async () => {
    const bundle = await archiveOf([
      { meta: meta({ path: 'state/x', type: 'dir', mode: 0o755, uid: 4_000_000_000, gid: 3_000_000_000 }) },
    ]);
    const entries: TarEntryMeta[] = [];
    for await (const entry of readTar(chunked(bundle, 512))) entries.push(entry.meta);
    expect(entries[0].uid).toBe(4_000_000_000);
    expect(entries[0].gid).toBe(3_000_000_000);
  });

  it('fails loudly when a file shrinks while being archived', async () => {
    const file = path.join(tmp, 'f');
    fs.writeFileSync(file, 'short');
    await expect(archiveOf([{ meta: meta({ path: 'state/f', size: 100 }), source: file }])).rejects.toMatchObject({
      code: 'file_changed',
    });
  });
});

describe('member validation', () => {
  async function extractItems(items: PackItem[], p: MemberPolicy = policy): Promise<void> {
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest, { recursive: true });
    await extractTar(chunked(await archiveOf(items), 512), dest, { policy: p });
  }
  const dir = (p: string): PackItem => ({ meta: meta({ path: p, type: 'dir', mode: 0o755 }) });

  it.each([
    ['absolute path', '/etc/x'],
    ['parent traversal', 'state/../../x'],
    ['dot segment', 'state/./x'],
    ['empty segment', 'state//x'],
    ['unknown top-level member', 'other/x'],
  ])('rejects %s', async (_label, p) => {
    await expect(extractItems([{ meta: meta({ path: p, type: 'dir', mode: 0o755 }) }])).rejects.toBeInstanceOf(
      TarError,
    );
  });

  it('rejects duplicate members', async () => {
    await expect(extractItems([dir('state'), dir('state')])).rejects.toMatchObject({ code: 'duplicate_member' });
  });

  it('rejects symlinks the policy does not allow', async () => {
    const items = [dir('state'), { meta: meta({ path: 'state/l', type: 'symlink', linkpath: '/etc/shadow' }) }];
    await expect(extractItems(items)).rejects.toMatchObject({ code: 'unsafe_symlink' });
    const escaping = [dir('state'), { meta: meta({ path: 'state/l', type: 'symlink', linkpath: '../../etc' }) }];
    await expect(extractItems(escaping, { topLevel: new Set(['state']) })).rejects.toMatchObject({
      code: 'unsafe_symlink',
    });
  });

  it('rejects hardlinks to missing files, directories and other members', async () => {
    await expect(
      extractItems([dir('state'), { meta: meta({ path: 'state/h', type: 'hardlink', linkpath: 'state/none' }) }]),
    ).rejects.toMatchObject({
      code: 'unsafe_hardlink',
    });
    await expect(
      extractItems([
        dir('state'),
        dir('state/d'),
        { meta: meta({ path: 'state/h', type: 'hardlink', linkpath: 'state/d' }) },
      ]),
    ).rejects.toMatchObject({ code: 'unsafe_hardlink' });
  });

  it('does not write through a symlink planted earlier in the archive', async () => {
    const victim = path.join(tmp, 'victim');
    fs.mkdirSync(victim);
    const items = [
      dir('state'),
      dir('state/sub'),
      { meta: meta({ path: 'state/a', type: 'symlink', linkpath: 'sub' }) }, // allowed: stays inside the member
      { meta: meta({ path: 'state/a/x', size: 0 }) },
    ];
    await expect(extractItems(items)).rejects.toMatchObject({ code: 'unsafe_member' });
    expect(fs.readdirSync(victim)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'dest', 'state', 'sub', 'x'))).toBe(false);
  });

  it('rejects entries whose parent directory is missing', async () => {
    await expect(extractItems([{ meta: meta({ path: 'state/orphan/x', size: 0 }) }])).rejects.toMatchObject({
      code: 'missing_parent',
    });
  });

  it('strips setuid, setgid and group/other write bits', async () => {
    const f = path.join(tmp, 'f');
    fs.writeFileSync(f, 'x');
    await extractItems([dir('state'), { meta: meta({ path: 'state/f', mode: 0o6777, size: 1 }), source: f }]);
    expect(fs.statSync(path.join(tmp, 'dest', 'state', 'f')).mode & 0o7777).toBe(0o755);
  });
});

describe('archives from other writers', () => {
  it('accepts a directory name that ends with a slash, as ustar writers commonly emit', async () => {
    const header = encodeEntryHeader(meta({ path: 'state', type: 'dir', mode: 0o755 }));
    header.fill(0, 0, 100);
    header.write('state/', 0, 'ascii');
    resetChecksum(header);
    const entries: TarEntryMeta[] = [];
    for await (const entry of readTar(chunked(Buffer.concat([header, Buffer.alloc(1024)]), 512)))
      entries.push(entry.meta);
    expect(entries.map((entry) => entry.path)).toEqual(['state']);
  });

  it('still rejects a path made only of slashes or with an empty segment', async () => {
    for (const bad of ['/', 'state//x/']) {
      const header = encodeEntryHeader(meta({ path: 'state', type: 'dir', mode: 0o755 }));
      header.fill(0, 0, 100);
      header.write(bad, 0, 'ascii');
      resetChecksum(header);
      const dest = path.join(tmp, `d${bad.length}`);
      fs.mkdirSync(dest);
      await expect(
        extractTar(chunked(Buffer.concat([header, Buffer.alloc(1024)]), 512), dest, { policy }),
      ).rejects.toBeInstanceOf(TarError);
    }
  });
});

describe('reader strictness', () => {
  async function rawEntries(buf: Buffer): Promise<TarEntryMeta[]> {
    const out: TarEntryMeta[] = [];
    for await (const entry of readTar(chunked(buf, 700))) out.push(entry.meta);
    return out;
  }

  it('rejects unsupported entry types such as GNU long names', async () => {
    const header = encodeEntryHeader(meta({ path: 'state/x' }));
    header[156] = 'L'.charCodeAt(0);
    resetChecksum(header);
    await expect(rawEntries(Buffer.concat([header, Buffer.alloc(1024)]))).rejects.toMatchObject({
      code: 'unsupported_type',
    });
  });

  it('rejects a corrupted header', async () => {
    const header = encodeEntryHeader(meta({ path: 'state/x' }));
    header[0] ^= 0xff;
    await expect(rawEntries(Buffer.concat([header, Buffer.alloc(1024)]))).rejects.toMatchObject({
      code: 'bad_checksum',
    });
  });

  it('rejects a truncated archive', async () => {
    const f = path.join(tmp, 'f');
    fs.writeFileSync(f, 'y'.repeat(2000));
    const bundle = await archiveOf([
      { meta: meta({ path: 'state', type: 'dir', mode: 0o755 }) },
      { meta: meta({ path: 'state/f', size: 2000 }), source: f },
    ]);
    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest);
    await expect(extractTar(Readable.from([bundle.subarray(0, 1300)]), dest, { policy })).rejects.toMatchObject({
      code: 'truncated',
    });
  });

  it('rejects a directory entry that claims a body', async () => {
    const header = encodeEntryHeader(meta({ path: 'state/d', type: 'dir', mode: 0o755 }));
    header.write('00000000100\0', 124, 'ascii');
    resetChecksum(header);
    await expect(rawEntries(Buffer.concat([header, Buffer.alloc(1536)]))).rejects.toMatchObject({ code: 'bad_header' });
  });
});
