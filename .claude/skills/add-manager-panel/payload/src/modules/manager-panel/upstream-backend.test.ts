/**
 * End to end against the real upstream schema: a migrated database, the real
 * backend, the real backup service and the real HTTP server. Only container
 * restarts are replaced (there is no Docker in the test environment).
 */
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const restarted: string[] = [];
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn(async (id: string) => {
    restarted.push(id);
    return 1;
  }),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initDb } from '../../db/connection.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { runMigrations } from '../../db/migrations/index.js';
import { verifyBundle } from '../manager-backup/bundle.js';
import { parseKey } from '../manager-backup/crypto.js';
import { BackupService } from '../manager-backup/service.js';
import { createUpstreamHost } from '../manager-backup/upstream-host.js';
import { generateSetupCode } from './password.js';
import { createPanelServer } from './server.js';
import { PanelState } from './state.js';
import { createUpstreamBackend } from './upstream-backend.js';
import type { ProbeResult } from './model-endpoint.js';

const PASSWORD = 'correct horse battery staple';
let tmp: string;
let server: http.Server;
let base: string;
const probe: ProbeResult = { reason: null, models: ['qwen3'], contextLimit: 32768, local: true };

async function api(
  method: string,
  route: string,
  session?: { cookie: string; csrf: string },
  body?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary JSON
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session) {
    headers.cookie = session.cookie;
    if (method !== 'GET') headers['x-csrf-token'] = session.csrf;
  }
  if (method !== 'GET') headers.origin = base;
  const res = await fetch(base + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

beforeEach(async () => {
  restarted.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-e2e-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'data'), { recursive: true });
  fs.mkdirSync(path.join(project, 'groups', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(project, 'groups', 'alpha', 'CLAUDE.local.md'), 'memory');
  fs.writeFileSync(path.join(project, '.env'), 'NANOCLAW_NAME=e2e\nOPENCODE_MODEL=openrouter/old\n');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'scratch', version: '9.9.9' }));

  await closeDb();
  const db = await initDb(path.join(project, 'data', 'v2.db'), { role: 'migration' });
  await runMigrations(db, undefined, { mode: 'migrate' });
  const now = new Date().toISOString();
  await createAgentGroup({
    id: 'g-alpha',
    name: 'Alpha',
    folder: 'alpha',
    agent_provider: null,
    created_at: now,
  } as never);
  await createAgentGroup({
    id: 'g-beta',
    name: 'Beta',
    folder: 'beta',
    agent_provider: null,
    created_at: now,
  } as never);
  await ensureContainerConfig('g-alpha');
  await db
    .run(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, created_at) VALUES ('mg1', 'telegram', 'chat-1', ?)",
      now,
    )
    .catch(() => undefined);

  const host = {
    ...createUpstreamHost({ db, projectRoot: process.cwd(), busyAgentCount: () => 0 }),
    projectRoot: project,
    dataDir: path.join(project, 'data'),
    groupsDir: path.join(project, 'groups'),
    storeDir: path.join(project, 'store'),
    envFile: path.join(project, '.env'),
    homeConfigDir: path.join(tmp, 'home'),
  };
  const state = new PanelState(path.join(project, 'data', 'manager-panel'));
  const backups = new BackupService({ host, backupsDir: path.join(tmp, 'backups') });
  const credentials = {
    status: async () => ({ claude: false, openaiKey: false, chatgptLogin: false }),
    saveClaude: async () => undefined,
    saveOpenAiKey: async () => undefined,
    removeCredential: async () => undefined,
    startChatgptLogin: () => ({ state: 'idle' as const }),
    loginState: () => ({ state: 'idle' as const }),
    cancelChatgptLogin: () => undefined,
  };
  const backend = createUpstreamBackend({ projectRoot: project, state, backups, credentials });
  backend.model.probe = async () => probe; // no network in tests
  server = createPanelServer({ state, backend, scrypt: { N: 2 ** 14, r: 8, p: 1 } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as { __state?: PanelState }).__state = state;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function signIn(): Promise<{ cookie: string; csrf: string }> {
  const state = (globalThis as { __state?: PanelState }).__state!;
  const setup = state.ensureSetupCode(new Date(), generateSetupCode, 60_000);
  const res = await api('POST', '/api/v1/setup', undefined, { code: setup.code, password: PASSWORD });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf: res.body.csrf_token };
}

describe('panel on a real install', () => {
  it('shows the real agents, channels and overview', async () => {
    const session = await signIn();
    const agents = await api('GET', '/api/v1/agents', session);
    expect(agents.body.agents.map((a: { name: string }) => a.name).sort()).toEqual(['Alpha', 'Beta']);
    const overview = await api('GET', '/api/v1/overview', session);
    expect(overview.body).toMatchObject({ agents: 2, running_agents: 0, backups: { count: 0, latest: null } });
    expect(overview.body.release).toBe('9.9.9');
    expect(JSON.stringify(agents.body)).not.toContain('g-alpha');
  });

  it('switches every agent to an OpenAI-compatible endpoint, in .env and in each group', async () => {
    const session = await signIn();
    await api('POST', '/api/v1/session/reauth', session, { password: PASSWORD });
    const res = await api('POST', '/api/v1/model/apply', session, {
      baseUrl: 'http://models.test:8000/v1',
      model: 'qwen3',
    });
    expect(res.body).toEqual({ agents: 2, restarted: 2, restart_failures: 0 });
    expect(restarted.sort()).toEqual(['g-alpha', 'g-beta']);

    const env = fs.readFileSync(path.join(tmp, 'project', '.env'), 'utf8');
    expect(env).toContain('NANOCLAW_NAME=e2e');
    expect(env).toContain('OPENCODE_PROVIDER=openai');
    expect(env).toContain('OPENCODE_BASE_URL=http://models.test:8000/v1');
    expect(env).toContain('OPENCODE_MODEL=openai/qwen3');
    for (const id of ['g-alpha', 'g-beta']) {
      expect(await getContainerConfig(id)).toMatchObject({ provider: 'opencode', model: 'openai/qwen3' });
    }
    const status = await api('GET', '/api/v1/model', session);
    expect(status.body.groups.every((g: { follows_settings: boolean }) => g.follows_settings)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'project', 'data', 'manager-panel', 'model-journal.json'))).toBe(false);
  });

  it('creates a real encrypted backup that verifies, downloads and opens with the returned key', async () => {
    const session = await signIn();
    await api('POST', '/api/v1/session/reauth', session, { password: PASSWORD });
    const created = await api('POST', '/api/v1/backups', session, {});
    expect(created.status).toBe(201);
    const { backup, key } = created.body;

    const verified = await api('POST', `/api/v1/backups/${backup.id}/verify`, session, { key });
    expect(verified.body).toMatchObject({ ok: true, consistency: 'quiescent' });

    const download = await fetch(`${base}/api/v1/backups/${backup.id}/download`, {
      headers: { cookie: session.cookie },
    });
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('MBK1');
    expect(bytes.includes('Alpha')).toBe(false);
    const copy = path.join(tmp, 'downloaded.mbk');
    fs.writeFileSync(copy, bytes);
    const result = await verifyBundle(copy, parseKey(key));
    expect(result.manifest.db.counts).toMatchObject({ agent_groups: 2 });
    expect(result.manifest.id).toBe(backup.id);
  });
});
