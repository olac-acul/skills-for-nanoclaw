/**
 * The voice channel's network checks: which addresses a wake-up push may go to, which requests come from this machine,
 * bearer tokens, failed logins and the small JSON bodies of `POST /pair` and `POST /notify`.
 */
import { timingSafeEqual } from 'crypto';
import { lookup } from 'dns/promises';
import type http from 'http';
import { isIP } from 'net';
import os from 'os';

import { log } from '../log.js';

/** Failed logins from one address before it is refused for FAILED_LOGIN_WINDOW_MS. */
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 10 * 60_000;
/** Addresses remembered with their failed logins: older ones are forgotten. */
const MAX_TRACKED_ADDRESSES = 200;
/** A request body that has not fully arrived after this long is dropped. */
const BODY_TIMEOUT_MS = 5000;

export type PushPolicy = 'public' | 'any';

/** The endpoint comes from the authenticated phone, but is only ever POSTed to: plain http(s) URLs, https by default. */
export function isValidEndpoint(url: string, policy: PushPolicy): boolean {
  if (url.length > 2048) return false;
  try {
    const u = new URL(url);
    if (policy === 'any') return u.protocol === 'https:' || u.protocol === 'http:';
    return (
      u.protocol === 'https:' && !u.username && !u.password && !isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))
    );
  } catch {
    return false;
  }
}

/** The endpoint's host must still resolve to public addresses only: no POST into the server's own network. */
export async function endpointIsPublic(url: string, policy: PushPolicy): Promise<boolean> {
  if (policy === 'any') return true;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return !isPrivateAddress(host);
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/** Loopback, private, link-local, CGNAT and unique-local addresses: never a target of the wake-up POST. */
export function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (v === 6) {
    // Read as bytes: an IPv4 address can hide in IPv6 in several forms ("::ffff:7f00:1" is 127.0.0.1).
    const b = ipv6Bytes(h);
    if (!b) return true; // not readable: not trusted to be public
    const zero = (n: number) => b.slice(0, n).every((x) => x === 0);
    const v4At = (i: number) => isPrivateAddress(b.slice(i, i + 4).join('.'));
    if (zero(16) || (zero(15) && b[15] === 1)) return true; // :: and ::1
    if (zero(10) && b[10] === 0xff && b[11] === 0xff) return v4At(12); // ::ffff:a.b.c.d (mapped)
    if (zero(12)) return v4At(12); // ::a.b.c.d (compatible, deprecated)
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0))
      return v4At(12); // NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return v4At(2); // 6to4
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo: tunnels anywhere
    return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b[0] === 0xff; // ULA, link-local, multicast
  }
  return false;
}

/** The 16 bytes of an IPv6 address (with "::" and a dotted IPv4 tail), or null when it is not one. */
export function ipv6Bytes(address: string): number[] | null {
  let text = address.split('%')[0];
  let tail: number[] | null = null;
  const dotted = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    tail = dotted.slice(1).map(Number);
    if (tail.some((x) => x > 255)) return null;
    text = `${text.slice(0, -dotted[0].length)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const bytes = all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Whether a request comes from this machine itself (loopback or one of its own addresses), not from the LAN. */
export function isOwnAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.replace(/^::ffff:/, '');
  if (plain === '::1' || plain.startsWith('127.')) return true;
  return Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((i) => i.address === plain));
}

/** `Authorization: Bearer <token>`, compared in constant time. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Wrong tokens or codes, by address: logged on the first and at the limit, and an address that keeps trying is refused
 * for a while. The right token always gets in (see the upgrade in voice.ts): behind a reverse proxy every client has the
 * proxy's address.
 */
export class FailedAttempts {
  private readonly tries = new Map<string, { count: number; since: number }>();

  constructor(private readonly what: string) {}

  /** Past the limit within the window. */
  refused(address: string): boolean {
    const entry = this.tries.get(address);
    if (entry && Date.now() - entry.since > FAILED_LOGIN_WINDOW_MS) this.tries.delete(address);
    return (this.tries.get(address)?.count ?? 0) >= MAX_FAILED_LOGINS;
  }

  note(address: string): void {
    const entry = this.tries.get(address) ?? { count: 0, since: Date.now() };
    entry.count++;
    this.tries.delete(address);
    this.tries.set(address, entry);
    while (this.tries.size > MAX_TRACKED_ADDRESSES) this.tries.delete(this.tries.keys().next().value as string);
    if (entry.count === 1 || entry.count === MAX_FAILED_LOGINS) {
      log.warn(this.what, { address, attempts: entry.count });
    }
  }

  forget(address: string): void {
    this.tries.delete(address);
  }
}

export function replyJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Reads a small request body. One over [maxBytes] gets 413 with [tooLarge] and the connection is closed once the answer
 * has gone out (the rest is not read); one that does not arrive within BODY_TIMEOUT_MS is dropped.
 */
export function readSmallBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes: number,
  tooLarge: unknown,
  onBody: (body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), BODY_TIMEOUT_MS);
  timer.unref();
  req.on('error', () => clearTimeout(timer));
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBytes) {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.once('finish', () => req.socket.destroy());
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
        res.end(JSON.stringify(tooLarge));
      }
    } else chunks.push(chunk);
  });
  req.on('end', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    onBody(Buffer.concat(chunks));
  });
}
