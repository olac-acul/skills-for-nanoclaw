/**
 * Login, first-run setup and re-authentication, all behind one global throttle
 * (there is a single administrator account).
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
import { LoginThrottle, SessionStore, type Session } from './sessions.js';
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

export class Auth {
  readonly sessions: SessionStore;
  private readonly throttle: LoginThrottle;
  private readonly scrypt: ScryptParams;

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

  private assertNotThrottled(): void {
    const wait = this.throttle.waitMs();
    if (wait > 0) throw new AuthError(429, 'login_throttled', Math.ceil(wait / 1000));
  }

  /** Check the password under the throttle; the failure is the same whatever the reason. */
  private async checkPassword(password: string): Promise<void> {
    this.assertNotThrottled();
    const admin = this.state.admin();
    if (!(await verifyPassword(password, admin?.password ?? null))) {
      this.throttle.failure();
      throw new AuthError(401, 'invalid_credentials');
    }
    this.throttle.success();
    if (admin && needsRehash(admin.password, this.scrypt)) {
      this.state.setPassword(await hashPassword(password, this.scrypt), new Date(this.now()));
    }
  }

  async login(password: string, previousToken?: string): Promise<{ token: string; session: Session }> {
    await this.checkPassword(password);
    this.sessions.destroy(previousToken);
    return this.sessions.create(this.generation());
  }

  async setup(code: string, password: string): Promise<{ token: string; session: Session }> {
    if (this.state.admin()) throw new AuthError(409, 'already_configured');
    this.assertNotThrottled();
    const pending = this.state.setupCode(new Date(this.now()));
    const given = Buffer.from(normalizeSetupCode(code));
    const expected = Buffer.from(pending?.code ?? '');
    if (!pending || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.throttle.failure();
      throw new AuthError(401, 'invalid_setup_code');
    }
    const problem = passwordProblem(password);
    if (problem) throw new AuthError(400, `password_${problem}`);
    this.state.setPassword(await hashPassword(password, this.scrypt), new Date(this.now()));
    this.state.clearSetupCode();
    this.throttle.success();
    return this.sessions.create(this.generation());
  }

  async reauth(session: Session, password: string): Promise<void> {
    await this.checkPassword(password);
    this.sessions.markReauth(session);
  }
}
