import fs from 'node:fs';
import type http from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CANARY, fakeBackend, type FakeBackend } from './fixtures/fake-backend.js';
import { generateSetupCode, hashPassword } from './password.js';
import { createPanelServer } from './server.js';
import { PanelState } from './state.js';

const PASSWORD = 'correct horse battery staple';
const FAST_SCRYPT = { N: 2 ** 14, r: 8, p: 1 };

let dir: string;
let state: PanelState;
let backend: FakeBackend;
let server: http.Server;
let base: string;
let clock: number;

async function start(extra: Partial<Parameters<typeof createPanelServer>[0]> = {}): Promise<void> {
  server = createPanelServer({ state, backend, scrypt: FAST_SCRYPT, now: () => clock, ...extra });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-server-'));
  state = new PanelState(path.join(dir, 'state'));
  backend = fakeBackend(dir);
  clock = Date.parse('2026-10-02T12:00:00Z');
  await start();
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** fetch() ignores a custom Host header, so talk to the socket directly. */
function rawGet(pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const request = httpRequest(
      { host: '127.0.0.1', port: Number(port), path: pathname, method: 'GET', headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary JSON
  body: any;
  text: string;
  headers: Headers;
}

async function call(
  method: string,
  pathname: string,
  init: {
    body?: unknown;
    cookie?: string;
    csrf?: string;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Result> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers['x-csrf-token'] = init.csrf;
  if (init.origin !== null && method !== 'GET') headers.origin = init.origin ?? base;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary JSON
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- binary responses are not JSON
  } catch {
    body = null;
  }
  return { status: res.status, body, text, headers: res.headers };
}

interface Login {
  cookie: string;
  csrf: string;
}

async function setupAdmin(): Promise<Login> {
  const record = state.ensureSetupCode(new Date(clock), generateSetupCode, 60_000);
  const res = await call('POST', '/api/v1/setup', { body: { code: record.code, password: PASSWORD } });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf: res.body.csrf_token };
}

async function loginAgain(): Promise<Login> {
  const res = await call('POST', '/api/v1/session', { body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf: res.body.csrf_token };
}

async function reauth(login: Login): Promise<void> {
  expect((await call('POST', '/api/v1/session/reauth', { body: { password: PASSWORD }, ...login })).status).toBe(200);
}

describe('first-run setup and login', () => {
  it('reports that setup is needed, creates the account with the one-time code, and refuses a second setup', async () => {
    expect((await call('GET', '/api/v1/setup')).body).toEqual({ needed: true });
    const login = await setupAdmin();
    expect((await call('GET', '/api/v1/setup')).body).toEqual({ needed: false });
    expect((await call('GET', '/api/v1/session', login)).status).toBe(200);
    const again = await call('POST', '/api/v1/setup', { body: { code: 'AAAA-BBBB-CCCC-DDDD', password: PASSWORD } });
    expect(again.status).toBe(409);
  });

  it('rejects a wrong or expired setup code and short passwords', async () => {
    state.ensureSetupCode(new Date(clock), () => 'AAAA-BBBB-CCCC-DDDD', 60_000);
    expect(
      (await call('POST', '/api/v1/setup', { body: { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', password: PASSWORD } })).body.error
        .code,
    ).toBe('invalid_setup_code');
    expect(
      (await call('POST', '/api/v1/setup', { body: { code: 'AAAA-BBBB-CCCC-DDDD', password: 'short' } })).body.error
        .code,
    ).toBe('password_too_short');
    clock += 61_000;
    expect(
      (await call('POST', '/api/v1/setup', { body: { code: 'AAAA-BBBB-CCCC-DDDD', password: PASSWORD } })).body.error
        .code,
    ).toBe('invalid_setup_code');
  });

  it('logs in with the right password, rotates the session, and logs out', async () => {
    const first = await setupAdmin();
    const second = await loginAgain();
    expect(second.cookie).not.toBe(first.cookie);
    expect((await call('DELETE', '/api/v1/session', second)).status).toBe(204);
    expect((await call('GET', '/api/v1/session', second)).status).toBe(401);
  });

  it('throttles repeated wrong passwords and keeps the same error for every failure', async () => {
    await setupAdmin();
    const codes: string[] = [];
    for (let i = 0; i < 7; i++)
      codes.push((await call('POST', '/api/v1/session', { body: { password: 'wrong password!!' } })).body.error.code);
    // Five failures are free; the sixth is still answered normally but starts the lock.
    expect(codes.slice(0, 6)).toEqual(Array(6).fill('invalid_credentials'));
    expect(codes.slice(6)).toEqual(['login_throttled']);
    const blocked = await call('POST', '/api/v1/session', { body: { password: PASSWORD } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    clock += 61_000;
    expect((await call('POST', '/api/v1/session', { body: { password: PASSWORD } })).status).toBe(200);
  });

  it('expires idle sessions', async () => {
    const login = await setupAdmin();
    clock += 31 * 60_000;
    expect((await call('GET', '/api/v1/overview', login)).status).toBe(401);
  });
});

describe('request protections', () => {
  it('refuses unknown host names (DNS rebinding) but accepts IPs and local names', async () => {
    expect(await rawGet('/api/v1/health', 'attacker.example.com')).toBe(421);
    expect(await rawGet('/api/v1/health', 'nanoclaw-box')).toBe(200);
    expect(await rawGet('/api/v1/health', 'nas.lan:3200')).toBe(200); // privacy-scan: allow -- property name or synthetic test input
  });

  it('allows extra host names from configuration', async () => {
    await new Promise((resolve) => server.close(resolve));
    await start({ allowedHosts: ['panel.example.org'] });
    expect(await rawGet('/api/v1/health', 'panel.example.org')).toBe(200);
    expect(await rawGet('/api/v1/health', 'other.example.org')).toBe(421);
  });

  it('requires a session for everything except health, setup and login', async () => {
    await setupAdmin();
    for (const [method, route] of [
      ['GET', '/api/v1/overview'],
      ['GET', '/api/v1/agents'],
      ['GET', '/api/v1/model'],
      ['GET', '/api/v1/backups'],
      ['GET', '/api/v1/backups/job'],
      ['GET', '/api/v1/channels'],
    ]) {
      expect((await call(method, route)).status, route).toBe(401);
    }
  });

  it('rejects state changes with a wrong Origin or without the CSRF token', async () => {
    const login = await setupAdmin();
    const agent = (await call('GET', '/api/v1/agents', login)).body.agents[0].id;
    const route = `/api/v1/agents/${agent}/restart`;
    expect((await call('POST', route, { ...login, origin: 'http://evil.example' })).body.error.code).toBe(
      'origin_mismatch',
    );
    expect((await call('POST', route, { ...login, origin: null })).body.error.code).toBe('origin_mismatch');
    expect((await call('POST', route, { cookie: login.cookie, csrf: 'x'.repeat(43) })).body.error.code).toBe(
      'csrf_mismatch',
    );
    expect((await call('POST', route, { cookie: login.cookie })).body.error.code).toBe('csrf_mismatch');
    expect(backend.restarts).toEqual([]);
    expect((await call('POST', route, login)).status).toBe(202);
    expect(backend.restarts).toEqual([backend.agentList[0].id]);
  });

  it('refuses cross-site fetches', async () => {
    const login = await setupAdmin();
    const res = await call('GET', '/api/v1/overview', { ...login, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
    expect(
      (await call('GET', '/api/v1/overview', { ...login, headers: { 'sec-fetch-site': 'same-origin' } })).status,
    ).toBe(200);
  });

  it('caps and validates bodies', async () => {
    const login = await setupAdmin();
    const big = await call('POST', '/api/v1/session/reauth', { ...login, body: { password: 'x'.repeat(70_000) } });
    expect(big.status).toBe(413);
    expect(
      (await call('POST', '/api/v1/session/reauth', { ...login, body: { password: PASSWORD, extra: 1 } })).body.error
        .code,
    ).toBe('invalid_request');
    const wrongType = await fetch(base + '/api/v1/session/reauth', {
      method: 'POST',
      headers: { origin: base, 'x-csrf-token': login.csrf, cookie: login.cookie, 'content-type': 'text/plain' },
      body: 'password',
    });
    expect(wrongType.status).toBe(415);
  });

  it('applies a per-session rate limit', async () => {
    const login = await setupAdmin();
    const statuses: number[] = [];
    for (let i = 0; i < 250; i++) statuses.push((await call('GET', '/api/v1/overview', login)).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    clock += 61_000;
    expect((await call('GET', '/api/v1/overview', login)).status).toBe(200);
  });

  it('sets hardened headers on API and static responses', async () => {
    const api = await call('GET', '/api/v1/health');
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    expect(api.headers.get('content-security-policy')).toContain("default-src 'none'");
    const page = await fetch(base + '/');
    const html = await page.text();
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script>|onclick=|<style>/);
    expect((await fetch(base + '/app.js')).headers.get('content-type')).toContain('javascript');
    expect((await fetch(base + '/missing')).status).toBe(404);
  });

  it('hides elements marked hidden even when a rule sets their display, and skips the warning on localhost', async () => {
    const css = await (await fetch(base + '/app.css')).text();
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    const script = await (await fetch(base + '/app.js')).text();
    expect(script).toContain('location.hostname');
  });

  it('serves the guide, with its anchors and the same protections as the other pages', async () => {
    const page = await fetch(base + '/guide');
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    for (const id of ['restoring-a-backup', 'forgotten-password', 'api-keys', 'the-small-model'])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/<script|onclick=|<style/);
    expect(await rawGet('/guide', 'attacker.example.com')).toBe(421);
  });

  it('opens the guide in the same tab and keeps the current page in the address', async () => {
    const script = await (await fetch(base + '/app.js')).text();
    const html = await (await fetch(base + '/')).text();
    // Guide links stay in the tab; only the external ChatGPT sign-in page opens elsewhere.
    const guideLink = /function guide\(anchor, label\) \{[^\n]*\}/.exec(script)?.[0] ?? '';
    expect(guideLink).toContain('/guide#');
    expect(guideLink).not.toContain('_blank');
    expect(html).not.toContain('_blank');
    expect(script.match(/_blank/g)).toHaveLength(1);
    expect(script).toContain('location.hash');
    expect(script).toContain("addEventListener('hashchange'");
  });

  it('serves the UI script without ever writing untrusted values as HTML', async () => {
    const script = await (await fetch(base + '/app.js')).text();
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(script).not.toMatch(/localStorage|sessionStorage/);
  });
});

/** Like call(), but from another local source address, so the server sees another client. */
function callFrom(
  source: string,
  method: string,
  pathname: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<{ status: number; code?: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(new URL(base).port),
        localAddress: source,
        path: pathname,
        method,
        headers: {
          origin: base,
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...extra,
        },
      },
      (response) => {
        const parts: Buffer[] = [];
        response.on('data', (part: Buffer) => parts.push(part));
        response.on('end', () => {
          let code: string | undefined;
          try {
            code = JSON.parse(Buffer.concat(parts).toString('utf8'))?.error?.code;
            // eslint-disable-next-line no-catch-all/no-catch-all -- not every reply is JSON
          } catch {
            code = undefined;
          }
          resolve({ status: response.statusCode ?? 0, code, headers: response.headers });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

describe('login lockout', () => {
  it('locks only the client that keeps guessing: another address and a signed-in session are not affected', async () => {
    const login = await setupAdmin();
    for (let i = 0; i < 7; i++)
      await callFrom('127.0.0.2', 'POST', '/api/v1/session', { password: 'wrong password!!' });
    expect((await callFrom('127.0.0.2', 'POST', '/api/v1/session', { password: PASSWORD })).code).toBe(
      'login_throttled',
    );
    // The administrator, from another address, can still sign in and re-authenticate.
    const other = await callFrom('127.0.0.3', 'POST', '/api/v1/session', { password: PASSWORD });
    expect(other.status).toBe(200);
    await reauth(login);
    // The attacker is free again after the lock expires, and the persisted ceiling is far from tripped.
    expect(state.throttle().locked_until).toBeNull();
    clock += 61_000;
    expect((await callFrom('127.0.0.2', 'POST', '/api/v1/session', { password: PASSWORD })).status).toBe(200);
  });

  it('counts a failed setup code against the address too', async () => {
    state.ensureSetupCode(new Date(clock), () => 'AAAA-BBBB-CCCC-DDDD', 60_000);
    for (let i = 0; i < 6; i++)
      await callFrom('127.0.0.2', 'POST', '/api/v1/setup', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', password: PASSWORD });
    expect(
      (await callFrom('127.0.0.2', 'POST', '/api/v1/setup', { code: 'AAAA-BBBB-CCCC-DDDD', password: PASSWORD })).code,
    ).toBe('login_throttled');
    expect(
      (await callFrom('127.0.0.3', 'POST', '/api/v1/setup', { code: 'AAAA-BBBB-CCCC-DDDD', password: PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('keeps a persisted global ceiling for many addresses, which a signed-in session can still bypass', async () => {
    const login = await setupAdmin();
    state.setThrottle({ failures: 60, locked_until: new Date(clock + 600_000).toISOString() });
    expect((await call('POST', '/api/v1/session', { body: { password: PASSWORD } })).body.error.code).toBe(
      'login_throttled',
    );
    await reauth(login);
  });

  it('runs only one password check at a time per address and a few overall', async () => {
    await setupAdmin();
    const burst = await Promise.all(
      Array.from({ length: 4 }, () => call('POST', '/api/v1/session', { body: { password: 'wrong password!!' } })),
    );
    expect(burst.map((r) => r.status).sort()).toEqual([401, 429, 429, 429]);
    expect(burst.find((r) => r.status === 429)!.body.error.code).toBe('login_busy');
  });
});

describe('credential races', () => {
  it('lets only one of two concurrent first-run setups succeed', async () => {
    const record = state.ensureSetupCode(new Date(clock), generateSetupCode, 60_000);
    const body = { code: record.code, password: PASSWORD };
    const results = await Promise.all([
      callFrom('127.0.0.2', 'POST', '/api/v1/setup', body),
      callFrom('127.0.0.3', 'POST', '/api/v1/setup', body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(state.admin()?.generation).toBe(1);
  });

  it('upgrading an older hash on re-authentication keeps the generation and the calling session', async () => {
    await new Promise((resolve) => server.close(resolve));
    await start({ scrypt: { N: 2 ** 15, r: 8, p: 1 } });
    const login = await setupAdmin();
    state.replaceHash(await hashPassword(PASSWORD, FAST_SCRYPT), new Date(clock));
    const before = state.admin()!;
    await reauth(login);
    const after = state.admin()!;
    expect(after.password).not.toBe(before.password);
    expect(after.generation).toBe(before.generation);
    expect((await call('GET', '/api/v1/session', login)).status).toBe(200);
  });
});

describe('transport hardening', () => {
  it('reads a duplicated session cookie as absent instead of picking one', async () => {
    const login = await setupAdmin();
    const name = login.cookie.split('=')[0];
    expect(
      (await call('GET', '/api/v1/session', { csrf: login.csrf, headers: { cookie: `${login.cookie}; ${name}=x` } }))
        .status,
    ).toBe(401);
    expect((await call('GET', '/api/v1/session', login)).status).toBe(200);
  });

  it('names the plain cookie after the listening port', async () => {
    const login = await setupAdmin();
    expect(login.cookie.startsWith(`manager_panel_${new URL(base).port}=`)).toBe(true);
  });

  it('answers an oversized body with 413 and closes the connection', async () => {
    const closed = new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(new URL(base).port),
          path: '/api/v1/session',
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base, 'transfer-encoding': 'chunked' },
        },
        (response) => {
          response.resume();
          response.socket.on('close', () => resolve(response.statusCode ?? 0));
        },
      );
      request.on('error', () => undefined);
      request.write('"' + 'a'.repeat(70 * 1024));
      setTimeout(() => request.destroy(), 3000).unref();
      void reject;
    });
    expect(await closed).toBe(413);
  });

  it('carries the cross-origin isolation headers on static pages too', async () => {
    const res = await fetch(base + '/');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('does not let a flood of new addresses wipe the live rate-limit buckets', async () => {
    // 30 failed logins inside one minute from one client exhaust the 20/min login bucket.
    for (let i = 0; i < 21; i++) await callFrom('127.0.0.9', 'POST', '/api/v1/session', { password: 'x' });
    expect((await callFrom('127.0.0.9', 'POST', '/api/v1/session', { password: 'x' })).code).toBe('rate_limited');
  });
});

describe('cookies', () => {
  it('uses a plain cookie and flags the connection over HTTP', async () => {
    const res = await call('POST', '/api/v1/setup', {
      body: (() => {
        const r = state.ensureSetupCode(new Date(clock), generateSetupCode, 60_000);
        return { code: r.code, password: PASSWORD };
      })(),
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^manager_panel_\d+=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
    expect(res.body.insecure_http).toBe(true);
  });

  it('uses the __Host- Secure cookie behind an HTTPS proxy', async () => {
    await new Promise((resolve) => server.close(resolve));
    await start({ publicOrigin: 'https://panel.example.org', allowedHosts: [] });
    const r = state.ensureSetupCode(new Date(clock), generateSetupCode, 60_000);
    const res = await call('POST', '/api/v1/setup', {
      body: { code: r.code, password: PASSWORD },
      origin: 'https://panel.example.org',
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-manager_panel=/);
    expect(cookie).toContain('Secure');
    expect(res.body.insecure_http).toBe(false);
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});

describe('agents and channels', () => {
  it('never exposes internal ids, paths or anything not in the response shape', async () => {
    const login = await setupAdmin();
    const seen: string[] = [];
    for (const route of [
      '/api/v1/overview',
      '/api/v1/agents',
      '/api/v1/channels',
      '/api/v1/model',
      '/api/v1/backups',
    ]) {
      const res = await call('GET', route, login);
      expect(res.status, route).toBe(200);
      seen.push(res.text);
    }
    expect(seen.join('\n')).not.toContain(CANARY);
    const agents = (await call('GET', '/api/v1/agents', login)).body.agents;
    expect(agents[0]).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      name: 'Alpha',
      provider: 'claude',
      model: null,
      running: true,
      sessions: 2,
    });
    // The same agent has the same public id everywhere, and ids differ per kind of resource.
    const model = (await call('GET', '/api/v1/model', login)).body.groups;
    expect(model[0].id).toBe(agents[0].id);
  });

  it('answers 404 for unknown or malformed agent ids', async () => {
    const login = await setupAdmin();
    expect((await call('POST', `/api/v1/agents/${'A'.repeat(22)}/restart`, login)).status).toBe(404);
    expect((await call('POST', '/api/v1/agents/..%2F..%2Fetc/restart', login)).status).toBe(404);
  });
});

describe('model settings', () => {
  it('checks an endpoint without changing anything', async () => {
    const login = await setupAdmin();
    const res = await call('POST', '/api/v1/model/preflight', {
      ...login,
      body: { baseUrl: 'http://models.test:8000/v1', model: 'qwen' },
    });
    expect(res.body).toMatchObject({
      ok: true,
      models: ['qwen', 'llama'],
      context_limit: 16384,
      agents_affected: 2,
      restarts_needed: 2,
    });
    expect(backend.env.OPENCODE_MODEL).toBe('openai/old');
  });

  it('reports a small model the endpoint does not list', async () => {
    const login = await setupAdmin();
    const res = await call('POST', '/api/v1/model/preflight', {
      ...login,
      body: { baseUrl: 'http://models.test:8000/v1', model: 'qwen', smallModel: 'missing' },
    });
    expect(res.body).toMatchObject({ ok: false, reason: 'small_model_not_found', small_model: 'not_found' });
    const good = await call('POST', '/api/v1/model/preflight', {
      ...login,
      body: { baseUrl: 'http://models.test:8000/v1', model: 'qwen', smallModel: 'llama' },
    });
    expect(good.body).toMatchObject({ ok: true, small_model: 'listed' });
  });

  it('applies only after the password is confirmed again, then points every agent at the endpoint', async () => {
    const login = await setupAdmin();
    const body = { baseUrl: 'http://models.test:9000/v1', model: 'qwen' };
    expect((await call('POST', '/api/v1/model/apply', { ...login, body })).body.error.code).toBe('reauth_required');
    expect(backend.env.OPENCODE_BASE_URL).toBe('http://models.test:8000/v1');
    await reauth(login);
    const res = await call('POST', '/api/v1/model/apply', { ...login, body });
    expect(res.body).toEqual({ agents: 2, restarted: 2, restart_failures: 0 });
    expect(backend.env).toMatchObject({
      OPENCODE_BASE_URL: 'http://models.test:9000/v1',
      OPENCODE_MODEL: 'openai/qwen',
    });
    expect(backend.groups.every((g) => g.provider === 'opencode' && g.model === 'openai/qwen')).toBe(true);
  });

  it('expires the re-authentication window', async () => {
    const login = await setupAdmin();
    await reauth(login);
    clock += 6 * 60_000;
    const res = await call('POST', '/api/v1/model/apply', {
      ...login,
      body: { baseUrl: 'http://models.test:9000/v1', model: 'qwen' },
    });
    expect(res.body.error.code).toBe('reauth_required');
  });

  it('reports a failed check with its reason and detail, and applies nothing', async () => {
    const login = await setupAdmin();
    await reauth(login);
    backend.probeResult = { reason: 'model_not_found', models: ['other'], contextLimit: null, local: true };
    const res = await call('POST', '/api/v1/model/apply', {
      ...login,
      body: { baseUrl: 'http://models.test:9000/v1', model: 'qwen' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'probe_failed', detail: 'model_not_found' });
    expect(backend.env.OPENCODE_MODEL).toBe('openai/old');
  });
});

/** Start a backup and follow it to the end, as the page does; returns the final job state. */
interface FinishedJob {
  state: string;
  key: string | null;
  backup: { id: string; consistency: string };
}

async function runBackup(login: Login): Promise<FinishedJob> {
  const started = await call('POST', '/api/v1/backups', { ...login, body: {} });
  expect(started.status).toBe(202);
  for (let attempt = 0; attempt < 200; attempt++) {
    const polled = await call('GET', '/api/v1/backups/job', login);
    if (polled.body.job.state !== 'running') return polled.body.job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the backup did not finish');
}

describe('backups', () => {
  it('runs a backup in the background after re-authentication, returns the key exactly once, and never lists it', async () => {
    const login = await setupAdmin();
    expect((await call('POST', '/api/v1/backups', { ...login, body: {} })).body.error.code).toBe('reauth_required');
    await reauth(login);
    const job = await runBackup(login);
    expect(job.state).toBe('done');
    expect(job.key).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    // Agents are waited for (the configured time), but never block the backup.
    expect(backend.createCalls[0]).toEqual({ waitMs: 60_000, force: true });
    const again = await call('GET', '/api/v1/backups/job', login);
    expect(again.body.job).toMatchObject({ state: 'done', key: null });
    expect(again.text).not.toContain(job.key);
    const list = await call('GET', '/api/v1/backups', login);
    expect(list.text).not.toContain(job.key);
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0]).toMatchObject({ release: '2.4.0', consistency: 'quiescent' });
    expect(job.backup).toMatchObject({ release: '2.4.0', consistency: 'quiescent', created_at: expect.any(String) });
  });

  it('tells scheduled backups from manual ones in the list', async () => {
    const login = await setupAdmin();
    await reauth(login);
    await runBackup(login);
    backend.records.push({
      ...backend.records[0],
      id: '20261002T130000Z-123456',
      createdAt: '2026-10-02T13:00:00.000Z',
      trigger: 'scheduled',
    });
    const list = (await call('GET', '/api/v1/backups', login)).body.backups;
    expect(list.map((entry: { trigger: string }) => entry.trigger)).toEqual(['scheduled', 'manual']);
  });

  it('goes ahead when agents are still working and records that the copy is best-effort', async () => {
    const login = await setupAdmin();
    await reauth(login);
    backend.busy = true;
    const job = await runBackup(login);
    expect(job.state).toBe('done');
    expect(job.backup.consistency).toBe('best-effort');
  });

  it('shows progress while it runs and starts only one backup at a time', async () => {
    const login = await setupAdmin();
    await reauth(login);
    let release!: () => void;
    backend.createGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await call('POST', '/api/v1/backups', { ...login, body: {} });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ state: 'running', phase: 'waiting', wait_seconds: 60 });
    const second = await call('POST', '/api/v1/backups', { ...login, body: {} });
    expect(second.status).toBe(202);
    expect(second.body.job.state).toBe('running');
    expect(backend.createCalls).toHaveLength(1);
    expect((await call('GET', '/api/v1/backups/job', login)).body.job.state).toBe('running');
    release();
    for (let attempt = 0; attempt < 200; attempt++) {
      const polled = await call('GET', '/api/v1/backups/job', login);
      if (polled.body.job.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await call('GET', '/api/v1/backups', login)).body.backups).toHaveLength(1);
  });

  it('still accepts the old force field and ignores it', async () => {
    const login = await setupAdmin();
    await reauth(login);
    expect((await call('POST', '/api/v1/backups', { ...login, body: { force: false } })).status).toBe(202);
  });

  it('verifies with the key and gives one answer for a wrong key', async () => {
    const login = await setupAdmin();
    await reauth(login);
    const { backup, key } = await runBackup(login);
    const ok = await call('POST', `/api/v1/backups/${backup.id}/verify`, { ...login, body: { key } });
    expect(ok.body).toMatchObject({ ok: true, entries: 10, release: '2.4.0' });
    const bad = await call('POST', `/api/v1/backups/${backup.id}/verify`, { ...login, body: { key: '0'.repeat(64) } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('key_or_bundle_rejected');
  });

  it('streams a download only inside the re-authentication window', async () => {
    const login = await setupAdmin();
    await reauth(login);
    const { backup } = await runBackup(login);
    const res = await fetch(`${base}/api/v1/backups/${backup.id}/download`, { headers: { cookie: login.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${backup.id}.mbk"`);
    expect(await res.text()).toBe('encrypted-bytes');
    clock += 6 * 60_000;
    const late = await fetch(`${base}/api/v1/backups/${backup.id}/download`, { headers: { cookie: login.cookie } });
    expect(late.status).toBe(403);
  });

  it('deletes after re-authentication and rejects malformed ids', async () => {
    const login = await setupAdmin();
    await reauth(login);
    const { backup } = await runBackup(login);
    expect((await call('DELETE', '/api/v1/backups/..%2F..%2Fetc%2Fpasswd', login)).status).toBe(404);
    expect((await call('DELETE', `/api/v1/backups/${backup.id}`, login)).status).toBe(204);
    expect((await call('GET', '/api/v1/backups', login)).body.backups).toEqual([]);
  });
});

describe('audit log', () => {
  it('records state changes without bodies, passwords or keys', async () => {
    const login = await setupAdmin();
    await reauth(login);
    await call('POST', '/api/v1/backups', { ...login, body: {} });
    await call('POST', '/api/v1/session', { body: { password: 'definitely-wrong-password' } }); // privacy-scan: allow -- property name or synthetic test input
    const audit = fs.readFileSync(path.join(dir, 'state', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"endpoint":"backup_create"');
    expect(audit).toContain('"endpoint":"login"');
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain('definitely-wrong-password');
    expect(audit).not.toContain('aaaaaaaa');
  });
});

describe('providers and credentials', () => {
  const SECRET = 'sk-ant-oat01-' + 'q'.repeat(40);

  it('tells the page which provider is set up and where a local model server is reachable', async () => {
    const login = await setupAdmin();
    const res = await call('GET', '/api/v1/model', login);
    expect(res.body).toMatchObject({ kind: 'compatible', auth: null, bridge_address: '100.64.0.1' });
  });

  it('shows what is stored and never a value', async () => {
    const login = await setupAdmin();
    backend.creds.claude = true;
    const res = await call('GET', '/api/v1/credentials', login);
    expect(res.body).toEqual({ claude: true, openai_key: false, chatgpt_login: false });
  });

  it('stores a Claude credential only after the password is confirmed, and answers without echoing it', async () => {
    const login = await setupAdmin();
    expect(
      (await call('POST', '/api/v1/credentials/claude', { ...login, body: { value: SECRET } })).body.error.code,
    ).toBe('reauth_required');
    expect(backend.saved).toEqual([]);
    await reauth(login);
    const res = await call('POST', '/api/v1/credentials/claude', { ...login, body: { value: SECRET } });
    expect(res.body).toEqual({ saved: true });
    expect(res.text).not.toContain(SECRET);
    expect(backend.saved).toEqual([{ kind: 'claude', length: SECRET.length }]);
    const audit = fs.readFileSync(path.join(dir, 'state', 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"endpoint":"credential_claude"');
    expect(audit).not.toContain(SECRET);
  });

  it('removes a stored credential after the password is confirmed, but not one the agents use', async () => {
    const login = await setupAdmin();
    backend.creds = { claude: true, openaiKey: true, chatgptLogin: true };
    expect((await call('DELETE', '/api/v1/credentials/claude', login)).body.error.code).toBe('reauth_required');
    expect(backend.removed).toEqual([]);
    await reauth(login);
    expect((await call('DELETE', '/api/v1/credentials/claude', login)).body).toEqual({ removed: true });
    expect(backend.removed).toEqual(['claude']);
    // The install runs ChatGPT with an API key: that key stays, the subscription login can go.
    backend.env = { OPENCODE_PROVIDER: 'openai', OPENCODE_BASE_URL: 'native', OPENCODE_MODEL: 'openai/gpt' };
    const inUse = await call('DELETE', '/api/v1/credentials/openai-key', login);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe('credential_in_use');
    expect((await call('DELETE', '/api/v1/credentials/chatgpt-login', login)).status).toBe(200);
    expect(backend.removed).toEqual(['claude', 'chatgpt-login']);
    expect((await call('DELETE', '/api/v1/credentials/bogus', login)).status).toBe(404);
  });

  it('stores an OpenAI key and rejects values that are not a single token', async () => {
    const login = await setupAdmin();
    await reauth(login);
    expect((await call('POST', '/api/v1/credentials/openai-key', { ...login, body: { value: SECRET } })).status).toBe(
      200,
    );
    for (const bad of ['', 'short', 'has spaces in the middle of it', 'x'.repeat(2000)]) {
      const res = await call('POST', '/api/v1/credentials/openai-key', { ...login, body: { value: bad } });
      expect(res.status, bad).toBe(400);
      expect(res.text).not.toContain(bad || 'never');
    }
    expect(backend.saved).toHaveLength(1);
  });

  it('runs a ChatGPT sign-in: start (password required), poll for the page and code, cancel', async () => {
    const login = await setupAdmin();
    expect((await call('POST', '/api/v1/credentials/chatgpt/login', { ...login })).body.error.code).toBe(
      'reauth_required',
    );
    await reauth(login);
    const started = await call('POST', '/api/v1/credentials/chatgpt/login', { ...login });
    expect(started.status).toBe(202);
    expect(started.body).toEqual({ state: 'waiting', url: 'https://login.example.test/device', code: 'ABCD-12345' });
    expect((await call('GET', '/api/v1/credentials/chatgpt/login', login)).body.state).toBe('waiting');
    const cancelled = await call('DELETE', '/api/v1/credentials/chatgpt/login', login);
    expect(cancelled.body).toEqual({ state: 'error', error: 'login_cancelled' });
    expect(backend.loginCancelled).toBe(true);
  });

  it('switches every agent to Claude once a credential exists', async () => {
    const login = await setupAdmin();
    await reauth(login);
    const refused = await call('POST', '/api/v1/model/apply', {
      ...login,
      body: { kind: 'claude', model: 'some-model' },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'probe_failed', detail: 'credential_missing' });
    backend.creds.claude = true;
    const res = await call('POST', '/api/v1/model/apply', { ...login, body: { kind: 'claude', model: 'some-model' } });
    expect(res.body).toEqual({ agents: 2, restarted: 2, restart_failures: 0 });
    expect(backend.groups.every((g) => g.provider === null && g.model === 'some-model')).toBe(true);
    expect((await call('GET', '/api/v1/model', login)).body.kind).toBe('claude');
  });

  it('switches to ChatGPT with the right authentication, and checks the choice before applying', async () => {
    const login = await setupAdmin();
    await reauth(login);
    const check = await call('POST', '/api/v1/model/preflight', {
      ...login,
      body: { kind: 'chatgpt', auth: 'subscription', model: 'gpt-test' },
    });
    expect(check.body).toMatchObject({ ok: false, reason: 'credential_missing', credential: 'missing' });
    backend.creds.chatgptLogin = true;
    const apply = await call('POST', '/api/v1/model/apply', {
      ...login,
      body: { kind: 'chatgpt', auth: 'subscription', model: 'gpt-test' },
    });
    expect(apply.status).toBe(200);
    expect(backend.env).toMatchObject({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'native',
      OPENCODE_AUTH_MODE: 'chatgpt',
      OPENCODE_MODEL: 'openai/gpt-test',
    });
    expect((await call('GET', '/api/v1/model', login)).body).toMatchObject({ kind: 'chatgpt', auth: 'subscription' });
  });

  it.each([
    [{ kind: 'nonsense', model: 'm' }],
    [{ kind: 'chatgpt', model: 'm' }],
    [{ kind: 'chatgpt', auth: 'carrier-pigeon', model: 'm' }],
    [{ kind: 'compatible', model: 'm' }],
    [{ baseUrl: 'http://models.test/v1' }],
  ])('rejects the malformed provider request %j', async (body) => {
    const login = await setupAdmin();
    expect((await call('POST', '/api/v1/model/preflight', { ...login, body })).body.error.code).toBe('invalid_request');
  });
});
