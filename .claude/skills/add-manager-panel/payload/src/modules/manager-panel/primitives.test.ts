import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PanelConfigError, isLoopbackBind, parsePanelConfig } from './config.js';
import {
  generateSetupCode,
  hashPassword,
  needsRehash,
  normalizeSetupCode,
  passwordProblem,
  verifyPassword,
} from './password.js';
import { hostAllowed, networkAllowed } from './server.js';
import { ABSOLUTE_MS, IDLE_MS, SessionStore } from './sessions.js';
import { PanelState } from './state.js';

const FAST = { N: 2 ** 14, r: 8, p: 1 };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-prim-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('password hashing', () => {
  it('verifies the right password only and never accepts a missing record', async () => {
    const hash = await hashPassword('a long enough passphrase', FAST);
    expect(hash).toMatch(/^scrypt\$1\$16384\$8\$1\$/);
    expect(await verifyPassword('a long enough passphrase', hash)).toBe(true);
    expect(await verifyPassword('another long passphrase', hash)).toBe(false);
    expect(await verifyPassword('anything at all', null)).toBe(false);
    expect(await verifyPassword('anything at all', 'garbage')).toBe(false);
  });

  it('applies length limits and Unicode normalisation', async () => {
    expect(passwordProblem('short')).toBe('too_short');
    expect(passwordProblem('x'.repeat(2000))).toBe('too_long');
    const hash = await hashPassword('café café café café', FAST);
    expect(await verifyPassword('café café café café', hash)).toBe(true);
  });

  it('asks for a rehash when stored parameters are weaker than current', async () => {
    const weak = await hashPassword('a long enough passphrase', FAST);
    expect(needsRehash(weak, FAST)).toBe(false);
    expect(needsRehash(weak, { N: 2 ** 15, r: 8, p: 1 })).toBe(true);
    expect(needsRehash('garbage', FAST)).toBe(true);
  });

  it('makes setup codes of 16 unambiguous characters and normalises typing slips', () => {
    const code = generateSetupCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(normalizeSetupCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
    expect(normalizeSetupCode('0O1I-L000-0000-0000')).toBe('0011-1000-0000-0000');
  });
});

describe('sessions', () => {
  it('rotates tokens, expires on idle and absolute limits, and dies with a credential change', () => {
    let clock = 1_000_000;
    const store = new SessionStore(() => clock);
    const { token, session } = store.create(1);
    expect(store.get(token, 1)).toBe(session);
    expect(store.get(token, 2)).toBeNull(); // password changed: generation moved on
    const second = store.create(2);
    clock += IDLE_MS - 1;
    expect(store.get(second.token, 2)).not.toBeNull(); // touching keeps it alive
    clock += IDLE_MS + 1;
    expect(store.get(second.token, 2)).toBeNull();
    const third = store.create(2);
    for (let step = 0; step < 20; step++) {
      clock += 25 * 60_000;
      store.get(third.token, 2);
    }
    expect(clock - third.session.createdAt).toBeGreaterThan(ABSOLUTE_MS);
    expect(store.get(third.token, 2)).toBeNull();
  });

  it('ignores malformed tokens and caps concurrent sessions', () => {
    const store = new SessionStore();
    expect(store.get('nope', 1)).toBeNull();
    expect(store.get(undefined, 1)).toBeNull();
    const tokens = Array.from({ length: 12 }, () => store.create(1).token);
    expect(tokens.filter((t) => store.get(t, 1, false))).toHaveLength(8);
  });

  it('keeps the re-authentication window short and bounded by the session', () => {
    let clock = 0;
    const store = new SessionStore(() => clock);
    const { session } = store.create(1);
    expect(store.hasReauth(session)).toBe(false);
    store.markReauth(session);
    expect(store.hasReauth(session)).toBe(true);
    clock += 5 * 60_000 + 1;
    expect(store.hasReauth(session)).toBe(false);
  });
});

describe('PanelState', () => {
  it('creates a private directory and refuses a world-readable one', () => {
    const private_ = path.join(dir, 'state');
    expect(fs.statSync(new PanelState(private_).directory).mode & 0o077).toBe(0);
    const loose = path.join(dir, 'loose');
    fs.mkdirSync(loose, { mode: 0o755 });
    fs.chmodSync(loose, 0o755);
    expect(() => new PanelState(loose)).toThrow(/private/);
  });

  it('refuses state files that are readable by others or malformed', async () => {
    const state = new PanelState(path.join(dir, 'state'));
    state.setPassword(await hashPassword('a long enough passphrase', FAST), new Date());
    expect(state.admin()?.generation).toBe(1);
    fs.chmodSync(path.join(dir, 'state', 'admin.json'), 0o644);
    expect(() => state.admin()).toThrow(/not private/);
    fs.chmodSync(path.join(dir, 'state', 'admin.json'), 0o600);
    fs.writeFileSync(
      path.join(dir, 'state', 'admin.json'),
      JSON.stringify({ schema: 'manager-panel-admin/v1', password: 'plain', generation: 1 }),
      { mode: 0o600 },
    );
    expect(() => state.admin()).toThrow(/invalid/);
  });

  it('bumps the generation on password change and on revoke', async () => {
    const state = new PanelState(path.join(dir, 'state'));
    const hash = await hashPassword('a long enough passphrase', FAST);
    expect(state.setPassword(hash, new Date()).generation).toBe(1);
    state.revokeSessions(new Date());
    expect(state.admin()?.generation).toBe(2);
    expect(state.setPassword(hash, new Date()).generation).toBe(3);
  });

  it('expires the setup code, reuses a live one and refuses once an admin exists', async () => {
    const state = new PanelState(path.join(dir, 'state'));
    const now = new Date('2026-10-02T00:00:00Z');
    const first = state.ensureSetupCode(now, () => 'AAAA-AAAA-AAAA-AAAA', 60_000);
    expect(state.ensureSetupCode(now, () => 'BBBB-BBBB-BBBB-BBBB', 60_000)).toEqual(first);
    expect(state.setupCode(new Date(now.getTime() + 61_000))).toBeNull();
    state.setPassword(await hashPassword('a long enough passphrase', FAST), now);
    expect(() => state.ensureSetupCode(now, generateSetupCode, 60_000)).toThrow(/already exists/);
  });

  it('keeps one stable identifier key', () => {
    const state = new PanelState(path.join(dir, 'state'));
    expect(state.idKey().equals(state.idKey())).toBe(true);
    expect(new PanelState(path.join(dir, 'state')).idKey().equals(state.idKey())).toBe(true);
    expect(fs.statSync(path.join(dir, 'state', 'id-key')).mode & 0o777).toBe(0o600);
  });

  it('rotates the audit log instead of growing without bound', () => {
    const state = new PanelState(path.join(dir, 'state'));
    const file = path.join(dir, 'state', 'audit.jsonl');
    fs.writeFileSync(file, 'x'.repeat(9 * 1024 * 1024), { mode: 0o600 });
    state.audit({ at: 't', endpoint: 'e', status: 200, request_id: 'r' });
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('configuration', () => {
  it('defaults to localhost on 3200 with backups under the user data directory', () => {
    const config = parsePanelConfig({}, 'slug1');
    expect(config).toMatchObject({
      enabled: true,
      bind: '127.0.0.1',
      port: 3200,
      allowPublic: false,
      allowedHosts: [],
      backupWaitSeconds: 60,
    });
    expect(config.backupDir).toContain(path.join('nanoclaw-backups', 'slug1'));
    expect(isLoopbackBind(config.bind)).toBe(true);
    expect(isLoopbackBind('0.0.0.0')).toBe(false);
  });

  it('reads overrides and validates them', () => {
    expect(
      parsePanelConfig(
        {
          PANEL_ENABLED: 'false',
          PANEL_PORT: '8080',
          PANEL_ALLOWED_HOSTS: 'a.example.org, b.example.org',
          PANEL_BIND: '0.0.0.0',
        },
        's',
      ),
    ).toMatchObject({
      enabled: false,
      port: 8080,
      bind: '0.0.0.0',
      allowedHosts: ['a.example.org', 'b.example.org'],
    });
    expect(() => parsePanelConfig({ PANEL_PORT: '99999' }, 's')).toThrow(PanelConfigError);
    expect(() => parsePanelConfig({ PANEL_PUBLIC_ORIGIN: 'https://panel.example.org/path' }, 's')).toThrow(
      PanelConfigError,
    );
    expect(() => parsePanelConfig({ PANEL_PUBLIC_ORIGIN: 'not a url' }, 's')).toThrow(PanelConfigError);
    expect(() => parsePanelConfig({ PANEL_TLS_CERT: '/x/cert.pem' }, 's')).toThrow(PanelConfigError);
  });
});

describe('network guards', () => {
  it('accepts local connections and refuses public ones unless allowed', () => {
    expect(networkAllowed('127.0.0.1', true)).toBe(true);
    expect(networkAllowed('::ffff:127.0.0.1', true)).toBe(true);
    expect(networkAllowed([192, 168, 1, 9].join('.'), true)).toBe(true);
    expect(networkAllowed('8.8.8.8', true)).toBe(false);
    expect(networkAllowed('2606:4700::1111', true)).toBe(false);
    expect(networkAllowed('8.8.8.8', false)).toBe(true);
  });

  it('judges Host headers', () => {
    for (const ok of [
      'localhost:3200',
      '127.0.0.1:3200',
      '[::1]:3200',
      'box',
      'nas.lan', // privacy-scan: allow -- property name or synthetic test input
      'printer.local:80', // privacy-scan: allow -- property name or synthetic test input
      'x.home.arpa', // privacy-scan: allow -- property name or synthetic test input
    ])
      expect(hostAllowed(ok, []), ok).toBe(true);
    for (const bad of ['', 'attacker.example.com', 'a.b.c.d.example.net', undefined])
      expect(hostAllowed(bad, []), String(bad)).toBe(false);
    expect(hostAllowed('panel.example.org:443', ['Panel.Example.org'])).toBe(true);
  });
});
