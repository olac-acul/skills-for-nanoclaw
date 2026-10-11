/**
 * Login, first-run setup and re-authentication. Failures are throttled per
 * client address first; a high global ceiling sits behind that (there is a
 * single administrator account), and a valid session may still re-authenticate
 * while it is on.
 */
import { timingSafeEqual } from 'node:crypto';

import {
  DEFAULT_PARAMS,
  hashPassword,
  needsRehash,
  normalizeSetupCode,
  passwordProblem,
  verifyPassword,
  type ScryptParams,
} from './password.js';
import { LoginThrottle, SessionStore, clientKey, type Session } from './sessions.js';
import type { PanelState } from './state.js';

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

/** Password checks run scrypt (~128 MiB each): only a few at once, and one per client. */
const MAX_CONCURRENT_CHECKS = 3;

export class Auth {
  readonly sessions: SessionStore;
  private readonly throttle: LoginThrottle;
  private readonly scrypt: ScryptParams;
  private checking = 0;
  private readonly checkingClients = new Set<string>();
  private settingUp = false;

  constructor(
    private readonly state: PanelState,
    private readonly now: () => number = Date.now,
    scrypt?: ScryptParams,
  ) {
    this.sessions = new SessionStore(now);
    this.throttle = new LoginThrottle(state, now);
    this.scrypt = scrypt ?? DEFAULT_PARAMS;
  }

  generation(): number {
    return this.state.admin()?.generation ?? 0;
  }

  setupNeeded(): boolean {
    return this.state.admin() === null;
  }

  private assertNotThrottled(client: string, ignoreGlobal = false): void {
    const wait = this.throttle.waitMs(client, ignoreGlobal);
    if (wait > 0) throw new AuthError(429, 'login_throttled', Math.ceil(wait / 1000));
  }

  /**
   * Check the password under the throttle; the failure is the same whatever the reason. `holdsSession` is a
   * caller that already has a valid session (re-authentication): the global ceiling does not stop it.
   */
  private async checkPassword(password: string, address: string, holdsSession = false): Promise<void> {
    const client = clientKey(address);
    this.assertNotThrottled(client, holdsSession);
    if (this.checking >= MAX_CONCURRENT_CHECKS || this.checkingClients.has(client)) {
      throw new AuthError(429, 'login_busy', 1);
    }
    this.checking += 1;
    this.checkingClients.add(client);
    try {
      const admin = this.state.admin();
      const valid = await verifyPassword(password, admin?.password ?? null);
      if (!valid) {
        this.throttle.failure(client);
        throw new AuthError(401, 'invalid_credentials');
      }
      // Other attempts may have tripped a lock while the hash was being computed.
      this.assertNotThrottled(client, holdsSession);
      this.throttle.success(client);
      if (admin && needsRehash(admin.password, this.scrypt)) {
        const upgraded = await hashPassword(password, this.scrypt);
        // Write only if nobody changed the credential meanwhile (a `reset-password` run must win).
        const current = this.state.admin();
        if (current && current.password === admin.password && current.generation === admin.generation) {
          this.state.replaceHash(upgraded, new Date(this.now()));
        }
      }
    } finally {
      this.checking -= 1;
      this.checkingClients.delete(client);
    }
  }

  async login(password: string, address: string, previousToken?: string): Promise<{ token: string; session: Session }> {
    await this.checkPassword(password, address);
    this.sessions.destroy(previousToken);
    return this.sessions.create(this.generation());
  }

  async setup(code: string, password: string, address: string): Promise<{ token: string; session: Session }> {
    if (this.state.admin()) throw new AuthError(409, 'already_configured');
    const client = clientKey(address);
    this.assertNotThrottled(client);
    const pending = this.state.setupCode(new Date(this.now()));
    const given = Buffer.from(normalizeSetupCode(code));
    const expected = Buffer.from(pending?.code ?? '');
    if (!pending || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.throttle.failure(client);
      throw new AuthError(401, 'invalid_setup_code');
    }
    const problem = passwordProblem(password);
    if (problem) throw new AuthError(400, `password_${problem}`);
    // The code is valid and nothing has awaited yet: only one setup may be in progress.
    if (this.settingUp) throw new AuthError(409, 'setup_in_progress');
    this.settingUp = true;
    try {
      const hash = await hashPassword(password, this.scrypt);
      if (this.state.admin()) throw new AuthError(409, 'already_configured');
      this.state.setPassword(hash, new Date(this.now()));
      this.state.clearSetupCode();
      this.throttle.success(client);
      return this.sessions.create(this.generation());
    } finally {
      this.settingUp = false;
    }
  }

  async reauth(session: Session, password: string, address: string): Promise<void> {
    await this.checkPassword(password, address, true);
    this.sessions.markReauth(session);
  }
}
