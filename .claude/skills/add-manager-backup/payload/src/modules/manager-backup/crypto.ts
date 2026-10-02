/**
 * Authenticated, streaming encryption for backup bundles.
 *
 * Format ("MBK1"): a 29-byte header followed by AES-256-GCM chunks.
 *
 *   magic "MBK1" | version 1 | chunk size log2 | salt (16) | nonce prefix (7)
 *
 * A per-bundle key is derived from the user's key with HKDF-SHA256 over the
 * random salt. Each chunk is sealed with a 96-bit nonce made of the prefix, a
 * 32-bit chunk counter and a final-chunk flag, and the header is bound in as
 * additional data. That makes reordering, dropping, truncating or appending
 * chunks, and tampering with the header, all fail authentication. A bundle is
 * therefore either exactly what was written or rejected.
 */
import crypto from 'node:crypto';

const MAGIC = Buffer.from('MBK1', 'ascii');
const VERSION = 1;
const HEADER_BYTES = 29;
const TAG_BYTES = 16;
const DEFAULT_CHUNK_LOG2 = 20; // 1 MiB
const MAX_CHUNKS = 0xffffffff;

export const KEY_BYTES = 32;

export class CryptoError extends Error {
  constructor(
    readonly code: 'bad_key' | 'bad_format' | 'authentication_failed' | 'truncated',
    message: string,
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/** Human-friendly form: 64 hex characters in groups of eight. */
export function formatKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new CryptoError('bad_key', 'key must be 32 bytes');
  return key.toString('hex').replace(/(.{8})(?=.)/g, '$1-');
}

export function parseKey(text: string): Buffer {
  const hex = text.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new CryptoError('bad_key', 'key must be 64 hexadecimal characters');
  return Buffer.from(hex, 'hex');
}

function deriveKey(key: Buffer, salt: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new CryptoError('bad_key', 'key must be 32 bytes');
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, 'manager-backup/v1 aes-256-gcm', KEY_BYTES));
}

function chunkNonce(prefix: Buffer, index: number, final: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 7);
  nonce[11] = final ? 1 : 0;
  return nonce;
}

function seal(subkey: Buffer, nonce: Buffer, header: Buffer, plain: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function open(subkey: Buffer, nonce: Buffer, header: Buffer, sealed: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new CryptoError('authentication_failed', 'wrong key, or the bundle is damaged or has been modified');
  }
}

export interface EncryptOptions {
  /** log2 of the plaintext chunk size; 20 (1 MiB) by default. Exposed for tests. */
  chunkLog2?: number;
}

/** Encrypt a byte stream. Always emits a final chunk, so an empty input is valid. */
export async function* encryptStream(
  plain: AsyncIterable<Buffer>,
  key: Buffer,
  options: EncryptOptions = {},
): AsyncGenerator<Buffer> {
  const chunkLog2 = options.chunkLog2 ?? DEFAULT_CHUNK_LOG2;
  const chunkSize = 2 ** chunkLog2;
  const salt = crypto.randomBytes(16);
  const prefix = crypto.randomBytes(7);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION, chunkLog2]), salt, prefix]);
  const subkey = deriveKey(key, salt);
  yield header;

  let index = 0;
  let held: Buffer[] = [];
  let heldBytes = 0;
  // One chunk of lookahead: a full chunk is only sealed once we know whether more data follows.
  const take = (n: number): Buffer => {
    const all = Buffer.concat(held);
    held = all.length > n ? [all.subarray(n)] : [];
    heldBytes = all.length > n ? all.length - n : 0;
    return all.subarray(0, n);
  };

  for await (const part of plain) {
    held.push(part);
    heldBytes += part.length;
    while (heldBytes > chunkSize) {
      if (index >= MAX_CHUNKS) throw new CryptoError('bad_format', 'stream too long');
      yield seal(subkey, chunkNonce(prefix, index++, false), header, take(chunkSize));
    }
  }
  yield seal(subkey, chunkNonce(prefix, index, true), header, Buffer.concat(held));
}

/** Decrypt a byte stream, verifying every chunk and the end of the stream. */
export async function* decryptStream(cipher: AsyncIterable<Buffer>, key: Buffer): AsyncGenerator<Buffer> {
  const iterator = cipher[Symbol.asyncIterator]();
  let held: Buffer[] = [];
  let heldBytes = 0;
  let ended = false;

  const fill = async (n: number): Promise<void> => {
    while (heldBytes < n && !ended) {
      const next = await iterator.next();
      if (next.done) ended = true;
      else if (next.value.length > 0) {
        held.push(next.value);
        heldBytes += next.value.length;
      }
    }
  };
  const take = (n: number): Buffer => {
    const all = Buffer.concat(held);
    const size = Math.min(n, all.length);
    held = all.length > size ? [all.subarray(size)] : [];
    heldBytes = all.length - size;
    return all.subarray(0, size);
  };

  await fill(HEADER_BYTES);
  const header = take(HEADER_BYTES);
  if (header.length < HEADER_BYTES) throw new CryptoError('truncated', 'bundle is shorter than its header');
  if (!header.subarray(0, 4).equals(MAGIC)) throw new CryptoError('bad_format', 'not a manager backup bundle');
  if (header[4] !== VERSION) throw new CryptoError('bad_format', `unsupported bundle version ${header[4]}`);
  const chunkLog2 = header[5];
  if (chunkLog2 < 10 || chunkLog2 > 26) throw new CryptoError('bad_format', 'invalid chunk size');
  const sealedSize = 2 ** chunkLog2 + TAG_BYTES;
  const salt = header.subarray(6, 22);
  const prefix = header.subarray(22, 29);
  const subkey = deriveKey(key, salt);

  let index = 0;
  for (;;) {
    // Read one chunk plus one byte: if nothing follows, this chunk is the final one.
    await fill(sealedSize + 1);
    if (heldBytes === 0) throw new CryptoError('truncated', 'bundle ends before its final chunk');
    const isFinal = heldBytes <= sealedSize;
    const sealed = take(isFinal ? heldBytes : sealedSize);
    if (isFinal && sealed.length < TAG_BYTES) throw new CryptoError('truncated', 'bundle ends inside a chunk');
    const plain = open(subkey, chunkNonce(prefix, index, isFinal), header, sealed);
    if (plain.length > 0) yield plain;
    if (isFinal) break;
    index++;
  }
}
