import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CryptoError, decryptStream, encryptStream, formatKey, generateKey, parseKey } from './crypto.js';

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part);
  return Buffer.concat(parts);
}

async function* parts(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

const SMALL = { chunkLog2: 10 }; // 1 KiB chunks keep the tests fast and boundary-heavy
const HEADER = 29;
const TAG = 16;

async function seal(plain: Buffer, key: Buffer, split = 333): Promise<Buffer> {
  return collect(encryptStream(parts(plain, split), key, SMALL));
}

describe('key handling', () => {
  it('round-trips the printable form and tolerates spacing and case', () => {
    const key = generateKey();
    const text = formatKey(key);
    expect(text).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    expect(parseKey(text).equals(key)).toBe(true);
    expect(parseKey(` ${text.toUpperCase().replace(/-/g, ' ')} \n`).equals(key)).toBe(true);
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63)]) {
      expect(() => parseKey(bad)).toThrow(CryptoError);
    }
  });
});

describe('encrypt / decrypt', () => {
  it.each([0, 1, 1023, 1024, 1025, 2048, 5000, 64 * 1024 + 7])('round-trips %i bytes', async (length) => {
    const key = generateKey();
    const plain = crypto.randomBytes(length);
    const sealed = await seal(plain, key);
    expect((await collect(decryptStream(parts(sealed, 777), key))).equals(plain)).toBe(true);
  });

  it('round-trips with the default chunk size', async () => {
    const key = generateKey();
    const plain = crypto.randomBytes(2 * 1024 * 1024 + 5);
    const sealed = await collect(encryptStream(parts(plain, 65536), key));
    expect((await collect(decryptStream(parts(sealed, 65536), key))).equals(plain)).toBe(true);
  });

  it('produces different ciphertext every time', async () => {
    const key = generateKey();
    const plain = Buffer.from('same input');
    expect((await seal(plain, key)).equals(await seal(plain, key))).toBe(false);
  });

  it('rejects the wrong key', async () => {
    const sealed = await seal(crypto.randomBytes(3000), generateKey());
    await expect(collect(decryptStream(parts(sealed, 500), generateKey()))).rejects.toMatchObject({
      code: 'authentication_failed',
    });
  });

  it('rejects a flipped bit anywhere, header included', async () => {
    const key = generateKey();
    const sealed = await seal(crypto.randomBytes(3000), key);
    for (const position of [0, 4, 5, 10, 25, HEADER + 5, sealed.length - 1]) {
      const damaged = Buffer.from(sealed);
      damaged[position] ^= 0x01;
      await expect(collect(decryptStream(parts(damaged, 500), key)), `byte ${position}`).rejects.toBeInstanceOf(
        CryptoError,
      );
    }
  });

  it('rejects truncation at chunk boundaries and mid-chunk', async () => {
    const key = generateKey();
    const sealed = await seal(crypto.randomBytes(5000), key);
    const chunk = 1024 + TAG;
    for (const length of [
      0,
      10,
      HEADER,
      HEADER + 5,
      HEADER + chunk,
      HEADER + 2 * chunk,
      sealed.length - 1,
      sealed.length - TAG,
    ]) {
      await expect(
        collect(decryptStream(parts(sealed.subarray(0, length), 500), key)),
        `length ${length}`,
      ).rejects.toBeInstanceOf(CryptoError);
    }
  });

  it('rejects appended data and reordered chunks', async () => {
    const key = generateKey();
    const sealed = await seal(crypto.randomBytes(5000), key);
    await expect(
      collect(decryptStream(parts(Buffer.concat([sealed, Buffer.from('x')]), 500), key)),
    ).rejects.toBeInstanceOf(CryptoError);
    await expect(
      collect(decryptStream(parts(Buffer.concat([sealed, sealed.subarray(HEADER)]), 500), key)),
    ).rejects.toBeInstanceOf(CryptoError);

    const chunk = 1024 + TAG;
    const swapped = Buffer.concat([
      sealed.subarray(0, HEADER),
      sealed.subarray(HEADER + chunk, HEADER + 2 * chunk),
      sealed.subarray(HEADER, HEADER + chunk),
      sealed.subarray(HEADER + 2 * chunk),
    ]);
    await expect(collect(decryptStream(parts(swapped, 500), key))).rejects.toMatchObject({
      code: 'authentication_failed',
    });
  });

  it('rejects data that is not a bundle', async () => {
    await expect(
      collect(decryptStream(parts(Buffer.from('this is not a bundle at all, sorry...'), 8), generateKey())),
    ).rejects.toMatchObject({
      code: 'bad_format',
    });
  });
});
