/**
 * Server-side sessions and the login throttle.
 *
 * Sessions live in memory: a restart logs the administrator out, which is
 * the safe direction. The cookie carries a random 256-bit token; only its
 * SHA-256 is kept, so a heap dump does not yield usable cookies. Each session
 * records the credential generation it was created under; a password change
 * or local reset bumps the generation and every older session stops working.
 *
 * The login throttle has two levels. Failures are counted per client address
 * (per /64 for IPv6) and lock only that client, so one machine on the network
 * cannot keep the administrator out. A global counter, persisted in the state
 * directory, is only a high ceiling against many addresses together; a valid
 * session can still re-authenticate while it is on. The local `unlock` command
 * clears the global lock.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { ipv6Groups, mappedIpv4 } from './ipv6.js';
import type { PanelState } from './state.js';

export const IDLE_MS = 30 * 60 * 1000;
export const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const REAUTH_MS = 5 * 60 * 1000;
export const MAX_SESSIONS = 8;

const FREE_FAILURES = 5;
const GLOBAL_FREE_FAILURES = 50;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const FIRST_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 4096;

export interface Session {
  /** Public to the server only: tells sessions apart (never sent to the browser). */
  id: string;
  createdAt: number;
  lastSeen: number;
  reauthUntil: number | null;
  csrf: string;
  generation: number;
}

export interface SessionView {
  expires_at: string;
  idle_expires_at: string;
  reauth_expires_at: string | null;
  csrf_token: string;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new session with a fresh token: login always rotates. */
  create(generation: number): { token: string; session: Session } {
    this.sweep(generation);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      this.sessions.delete(oldest[0]);
    }
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    const session: Session = {
      id: randomBytes(16).toString('hex'),
      createdAt: at,
      lastSeen: at,
      reauthUntil: null,
      csrf: randomBytes(32).toString('base64url'),
      generation,
    };
    this.sessions.set(digest(token), session);
    return { token, session };
  }

  /** The live session for a cookie token, refreshing its idle timer; null when expired or revoked. */
  get(token: string | undefined, generation: number, touch = true): Session | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = digest(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    const at = this.now();
    if (session.generation !== generation || at - session.lastSeen > IDLE_MS || at - session.createdAt > ABSOLUTE_MS) {
      this.sessions.delete(key);
      return null;
    }
    if (touch) session.lastSeen = at;
    return session;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(digest(token));
  }

  markReauth(session: Session): void {
    session.reauthUntil = Math.min(this.now() + REAUTH_MS, session.createdAt + ABSOLUTE_MS);
  }

  hasReauth(session: Session): boolean {
    return session.reauthUntil !== null && this.now() <= session.reauthUntil;
  }

  csrfMatches(session: Session, header: string | undefined): boolean {
    if (!header) return false;
    const a = Buffer.from(session.csrf);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  view(session: Session): SessionView {
    return {
      expires_at: iso(session.createdAt + ABSOLUTE_MS),
      idle_expires_at: iso(Math.min(session.lastSeen + IDLE_MS, session.createdAt + ABSOLUTE_MS)),
      reauth_expires_at: this.hasReauth(session) ? iso(session.reauthUntil!) : null,
      csrf_token: session.csrf,
    };
  }

  private sweep(generation: number): void {
    const at = this.now();
    for (const [key, session] of this.sessions) {
      if (
        session.generation !== generation ||
        at - session.lastSeen > IDLE_MS ||
        at - session.createdAt > ABSOLUTE_MS
      ) {
        this.sessions.delete(key);
      }
    }
  }
}

/**
 * The key a client is counted under: the address, with IPv4-mapped IPv6 unwrapped and a whole /64 for IPv6
 * (a single host controls every address in its /64).
 */
export function clientKey(address: string | undefined): string {
  const raw = (address ?? 'unknown').toLowerCase().split('%')[0];
  const groups = raw.includes(':') ? ipv6Groups(raw) : null;
  if (!groups) return raw;
  return mappedIpv4(groups) ?? `${groups.slice(0, 4).map((n) => n.toString(16)).join(':')}::/64`;
}

interface ClientRecord {
  failures: number;
  lockedUntil: number;
  last: number;
}

function lockFor(failures: number, free: number): number {
  const over = failures - free;
  return over > 0 ? Math.min(FIRST_LOCK_MS * 2 ** (over - 1), MAX_LOCK_MS) : 0;
}

export class LoginThrottle {
  /** Per-client counters live in memory: they only have to hold against the client that is guessing. */
  private readonly clients = new Map<string, ClientRecord>();

  constructor(
    private readonly state: PanelState,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Milliseconds this client must wait before another attempt; 0 when free. The global ceiling applies too,
   * except for a caller that already holds a valid session.
   */
  waitMs(client: string, ignoreGlobal = false): number {
    const at = this.now();
    let wait = Math.max(0, (this.clients.get(client)?.lockedUntil ?? 0) - at);
    if (!ignoreGlobal) {
      const { locked_until } = this.state.throttle();
      if (locked_until) wait = Math.max(wait, Date.parse(locked_until) - at);
    }
    return Math.max(0, wait);
  }

  failure(client: string): void {
    const at = this.now();
    const record = this.clients.get(client) ?? { failures: 0, lockedUntil: 0, last: at };
    // A client that has been quiet for the longest lock starts over.
    if (at - record.last > MAX_LOCK_MS && record.lockedUntil <= at) record.failures = 0;
    record.failures += 1;
    record.last = at;
    record.lockedUntil = at + lockFor(record.failures, FREE_FAILURES);
    this.clients.delete(client);
    this.clients.set(client, record);
    this.trim(at);

    // The persisted ceiling counts failures inside a one-hour window, so slow typos never add up to a lock.
    const stored = this.state.throttle();
    const windowStart = stored.window_start ? Date.parse(stored.window_start) : NaN;
    const fresh = !(at - windowStart <= GLOBAL_WINDOW_MS) || at < windowStart;
    const failures = fresh ? 1 : stored.failures + 1;
    const lock = lockFor(failures, GLOBAL_FREE_FAILURES);
    this.state.setThrottle({
      failures,
      locked_until: lock ? new Date(at + lock).toISOString() : null,
      window_start: fresh ? new Date(at).toISOString() : stored.window_start,
    });
  }

  success(client: string): void {
    this.clients.delete(client);
    this.state.setThrottle({ failures: 0, locked_until: null });
  }

  private trim(at: number): void {
    if (this.clients.size <= MAX_TRACKED_CLIENTS) return;
    for (const [key, record] of this.clients) {
      if (record.lockedUntil <= at && at - record.last > MAX_LOCK_MS) this.clients.delete(key);
    }
    // Still full: drop the least recently failing client (Map keeps insertion order, failures re-insert).
    while (this.clients.size > MAX_TRACKED_CLIENTS) this.clients.delete(this.clients.keys().next().value!);
  }
}
