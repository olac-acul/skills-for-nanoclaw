/**
 * Public identifiers that reveal nothing about the internal ones.
 *
 * Internal ids can be built from chat or folder names. The browser sees a
 * keyed hash instead; the server resolves it by hashing the ids it knows.
 */
import { createHmac } from 'node:crypto';

export const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;

export function publicId(key: Buffer, kind: string, internalId: string): string {
  return createHmac('sha256', key).update(`${kind}\0${internalId}`).digest('base64url').slice(0, 22);
}

export function resolveId<T extends { id: string }>(
  key: Buffer,
  kind: string,
  candidates: readonly T[],
  given: string,
): T | null {
  if (!PUBLIC_ID.test(given)) return null;
  return candidates.find((candidate) => publicId(key, kind, candidate.id) === given) ?? null;
}
