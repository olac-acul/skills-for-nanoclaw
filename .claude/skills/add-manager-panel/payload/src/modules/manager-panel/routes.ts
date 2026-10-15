/**
 * The panel's API: what each endpoint requires and what it returns.
 *
 * Responses are built field by field from the backend's data; nothing is
 * passed through. Internal ids never leave the process (agents get keyed
 * hashes), and no endpoint returns a credential, a path, or a log line.
 */
import { CryptoError } from '../manager-backup/crypto.js';
import { BackupError } from '../manager-backup/service.js';
import { AuthError, type Auth } from './auth.js';
import { BackupJobError, type BackupJobs, type JobStatus } from './backup-job.js';
import type { PanelBackend } from './backend.js';
import { CredentialError } from './credentials.js';
import { isCredentialKind, validSecret } from './credentials-protocol.js';
import {
  ModelSettingsError,
  applyProviderChange,
  detectProvider,
  previewProviderChange,
  readModelStatus,
  type ProviderInput,
} from './model-settings.js';
import { publicId, resolveId } from './opaque-id.js';
import { PhoneError } from './phone.js';
import type { Session } from './sessions.js';
import type { PanelState } from './state.js';
import { InvalidBody, fields, noBody } from './validate.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
    readonly detail?: string,
  ) {
    super(code);
  }
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  file?: { path: string; filename: string };
}

export interface RouteDeps {
  backend: PanelBackend;
  auth: Auth;
  state: PanelState;
  /** The browser reaches the panel over plain HTTP (a banner is shown). */
  insecureHttp: boolean;
  setCookie(token: string): string;
  clearCookie(): string;
  /** Runs backups in the background and reports their progress. */
  backupJobs: BackupJobs;
}

export interface RouteContext {
  params: string[];
  body: unknown;
  session: Session | null;
  token: string | undefined;
  /** The peer address of the connection (never a forwarded header). */
  address: string;
  deps: RouteDeps;
}

export type LimitClass = 'read' | 'mutation' | 'probe' | 'login';

export interface Route {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  pattern: RegExp;
  access: 'anon' | 'session';
  /** Changes state: needs a matching Origin and the CSRF token. */
  mutating: boolean;
  /** Needs the password re-entered within the last few minutes. */
  reauth?: boolean;
  limit: LimitClass;
  parse(raw: unknown): unknown;
  run(ctx: RouteContext): Promise<Reply>;
}

const BACKUP_ID = '(\\d{8}T\\d{6}Z-[0-9a-f]{6})';
const PUBLIC = '([A-Za-z0-9_-]{22})';

function sessionView(deps: RouteDeps, session: Session): Record<string, unknown> {
  return { ...deps.auth.sessions.view(session), insecure_http: deps.insecureHttp };
}

async function loadAgent(ctx: RouteContext, given: string) {
  const agents = await ctx.deps.backend.agents();
  const found = resolveId(ctx.deps.state.idKey(), 'agent', agents, given);
  if (!found) throw new HttpError(404, 'not_found');
  return { found, agents };
}

/** The body of the model preflight and apply calls: an endpoint (the default), ChatGPT or Claude. */
export function parseProviderBody(raw: unknown): ProviderInput {
  const body = fields<{
    kind?: string;
    auth?: string;
    baseUrl?: string;
    model?: string;
    smallModel?: string;
    images?: boolean;
  }>(raw, {
    kind: { type: 'string', max: 20, optional: true },
    auth: { type: 'string', max: 20, optional: true },
    baseUrl: { type: 'string', max: 2048, optional: true },
    model: { type: 'string', max: 200, optional: true },
    smallModel: { type: 'string', max: 200, optional: true },
    images: { type: 'boolean', optional: true },
  });
  const kind = body.kind ?? 'compatible';
  if (kind === 'compatible') {
    if (!body.baseUrl) throw new InvalidBody('baseUrl');
    if (!body.model) throw new InvalidBody('model');
    return { kind, baseUrl: body.baseUrl, model: body.model, smallModel: body.smallModel, images: body.images };
  }
  if (kind === 'chatgpt') {
    if (body.auth !== 'subscription' && body.auth !== 'api-key') throw new InvalidBody('auth');
    if (!body.model) throw new InvalidBody('model');
    return { kind, auth: body.auth, model: body.model, smallModel: body.smallModel, images: body.images };
  }
  if (kind === 'claude') return { kind, model: body.model };
  throw new InvalidBody('kind');
}

function secretBody(raw: unknown): { value: string } {
  const { value } = fields<{ value: string }>(raw, { value: { type: 'string', max: 1024 } });
  if (!validSecret(value)) throw new InvalidBody('value');
  return { value };
}

export function buildRoutes(): Route[] {
  const routes: Route[] = [];
  const add = (route: Route): void => {
    routes.push(route);
  };

  add({
    name: 'health',
    method: 'GET',
    pattern: /^\/api\/v1\/health$/,
    access: 'anon',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async () => ({ status: 200, body: { status: 'ok' } }),
  });

  add({
    name: 'setup_state',
    method: 'GET',
    pattern: /^\/api\/v1\/setup$/,
    access: 'anon',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => ({ status: 200, body: { needed: ctx.deps.auth.setupNeeded() } }),
  });

  add({
    name: 'setup',
    method: 'POST',
    pattern: /^\/api\/v1\/setup$/,
    access: 'anon',
    mutating: true,
    limit: 'login',
    parse: (raw) =>
      fields<{ code: string; password: string }>(raw, {
        code: { type: 'string', max: 64 },
        password: { type: 'string', max: 4096 },
      }),
    run: async (ctx) => {
      const { code, password } = ctx.body as { code: string; password: string };
      const created = await ctx.deps.auth.setup(code, password, ctx.address);
      return {
        status: 200,
        body: sessionView(ctx.deps, created.session),
        headers: { 'set-cookie': ctx.deps.setCookie(created.token) },
      };
    },
  });

  add({
    name: 'login',
    method: 'POST',
    pattern: /^\/api\/v1\/session$/,
    access: 'anon',
    mutating: true,
    limit: 'login',
    parse: (raw) => fields<{ password: string }>(raw, { password: { type: 'string', max: 4096 } }),
    run: async (ctx) => {
      const created = await ctx.deps.auth.login((ctx.body as { password: string }).password, ctx.address, ctx.token);
      return {
        status: 200,
        body: sessionView(ctx.deps, created.session),
        headers: { 'set-cookie': ctx.deps.setCookie(created.token) },
      };
    },
  });

  add({
    name: 'session',
    method: 'GET',
    pattern: /^\/api\/v1\/session$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => ({ status: 200, body: sessionView(ctx.deps, ctx.session!) }),
  });

  add({
    name: 'logout',
    method: 'DELETE',
    pattern: /^\/api\/v1\/session$/,
    access: 'session',
    mutating: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      ctx.deps.auth.sessions.destroy(ctx.token);
      return { status: 204, headers: { 'set-cookie': ctx.deps.clearCookie() } };
    },
  });

  add({
    name: 'reauth',
    method: 'POST',
    pattern: /^\/api\/v1\/session\/reauth$/,
    access: 'session',
    mutating: true,
    limit: 'login',
    parse: (raw) => fields<{ password: string }>(raw, { password: { type: 'string', max: 4096 } }),
    run: async (ctx) => {
      await ctx.deps.auth.reauth(ctx.session!, (ctx.body as { password: string }).password, ctx.address);
      return { status: 200, body: sessionView(ctx.deps, ctx.session!) };
    },
  });

  add({
    name: 'overview',
    method: 'GET',
    pattern: /^\/api\/v1\/overview$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => {
      const o = await ctx.deps.backend.overview();
      const backups = ctx.deps.backend.backups.list();
      return {
        status: 200,
        body: {
          release: o.release,
          gateway: o.gateway,
          channels: o.channels,
          providers: o.providers,
          agents: o.agents,
          running_agents: o.runningAgents,
          sessions: o.sessions,
          uptime_seconds: o.uptimeSeconds,
          backups: { count: backups.length, latest: backups[0]?.createdAt ?? null },
        },
      };
    },
  });

  add({
    name: 'agents',
    method: 'GET',
    pattern: /^\/api\/v1\/agents$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => {
      const key = ctx.deps.state.idKey();
      const agents = await ctx.deps.backend.agents();
      return {
        status: 200,
        body: {
          agents: agents.map((a) => ({
            id: publicId(key, 'agent', a.id),
            name: a.name,
            provider: a.provider,
            model: a.model,
            running: a.running,
            sessions: a.sessions,
          })),
        },
      };
    },
  });

  add({
    name: 'agent_restart',
    method: 'POST',
    pattern: new RegExp(`^/api/v1/agents/${PUBLIC}/restart$`),
    access: 'session',
    mutating: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      const { found } = await loadAgent(ctx, ctx.params[0]);
      await ctx.deps.backend.restartAgent(found.id);
      return { status: 202, body: { status: 'restarting' } };
    },
  });

  add({
    name: 'channels',
    method: 'GET',
    pattern: /^\/api\/v1\/channels$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => ({
      status: 200,
      body: { channels: (await ctx.deps.backend.channels()).map((c) => ({ type: c.type, chats: c.chats })) },
    }),
  });

  add({
    name: 'model',
    method: 'GET',
    pattern: /^\/api\/v1\/model$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => {
      const key = ctx.deps.state.idKey();
      const names = new Map((await ctx.deps.backend.agents()).map((a) => [a.id, a.name]));
      const status = await readModelStatus(ctx.deps.backend.model);
      const detected = detectProvider(
        { OPENCODE_PROVIDER: status.provider, OPENCODE_BASE_URL: status.baseUrl, OPENCODE_AUTH_MODE: status.authMode },
        status.groups,
      );
      return {
        status: 200,
        body: {
          kind: detected.kind,
          auth: detected.auth,
          bridge_address: ctx.deps.backend.bridgeAddress(),
          provider: status.provider,
          base_url: status.baseUrl,
          model: status.model,
          small_model: status.smallModel,
          images: status.images,
          interrupted: status.interrupted,
          groups: status.groups.map((g) => ({
            id: publicId(key, 'agent', g.id),
            name: names.get(g.id) ?? 'agent',
            provider: g.provider,
            model: g.model,
            follows_settings: g.followsSettings,
          })),
        },
      };
    },
  });

  add({
    name: 'model_preflight',
    method: 'POST',
    pattern: /^\/api\/v1\/model\/preflight$/,
    access: 'session',
    mutating: true,
    limit: 'probe',
    parse: parseProviderBody,
    run: async (ctx) => {
      const preview = await previewProviderChange(ctx.deps.backend.model, ctx.body as ProviderInput);
      return {
        status: 200,
        body: {
          ok: preview.ok,
          reason: preview.reason,
          credential: preview.credential,
          small_model: preview.smallModel,
          models: preview.models,
          context_limit: preview.contextLimit,
          image_support: preview.imageSupport,
          local: preview.local, // privacy-scan: allow -- property name
          agents_affected: preview.groupsAffected,
          restarts_needed: preview.restartsNeeded,
        },
      };
    },
  });

  add({
    name: 'model_apply',
    method: 'POST',
    pattern: /^\/api\/v1\/model\/apply$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: parseProviderBody,
    run: async (ctx) => {
      const outcome = await applyProviderChange(ctx.deps.backend.model, ctx.body as ProviderInput);
      return {
        status: 200,
        body: {
          agents: outcome.groups,
          restarted: outcome.restarted,
          restart_failures: outcome.restartFailures.length,
        },
      };
    },
  });

  add({
    name: 'phone_status',
    method: 'GET',
    pattern: /^\/api\/v1\/phone$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => {
      const s = await ctx.deps.backend.phone.status();
      return {
        status: 200,
        body: {
          installed: s.installed,
          enabled: s.enabled,
          listening: s.listening,
          connected: s.connected,
          connected_at: s.connectedAt,
          last_disconnect_at: s.lastDisconnectAt,
          locale: s.locale,
          url: s.url,
          address_problem: s.addressProblem,
          token_set: s.tokenSet,
          push_registered: s.pushRegistered,
          agent: s.agent,
          restart_needed: s.restartNeeded,
          paired_at: s.pairedAt,
          paired_device: s.pairedDevice,
          pairing_pending: s.pairingPending,
        },
      };
    },
  });

  // A new token is returned once and never read back; the app's current connection ends.
  add({
    name: 'phone_token',
    method: 'POST',
    pattern: /^\/api\/v1\/phone\/token$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => ({ status: 200, body: { token: await ctx.deps.backend.phone.newToken() } }),
  });

  // The QR code for pairing the app: shown once, to the person who confirmed the password. No token in it.
  add({
    name: 'phone_pairing_start',
    method: 'POST',
    pattern: /^\/api\/v1\/phone\/pairing$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      const started = await ctx.deps.backend.phone.startPairing();
      return { status: 200, body: { matrix: started.matrix, expires_at: started.expiresAt } };
    },
  });

  add({
    name: 'phone_pairing_cancel',
    method: 'DELETE',
    pattern: /^\/api\/v1\/phone\/pairing$/,
    access: 'session',
    mutating: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      await ctx.deps.backend.phone.cancelPairing();
      return { status: 200, body: {} };
    },
  });

  add({
    name: 'phone_enabled',
    method: 'POST',
    pattern: /^\/api\/v1\/phone\/enabled$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: (raw) => fields<{ enabled: boolean }>(raw, { enabled: { type: 'boolean' } }),
    run: async (ctx) => {
      const { enabled } = ctx.body as { enabled: boolean };
      await ctx.deps.backend.phone.setEnabled(enabled);
      return { status: 200, body: { enabled, restart_needed: true } };
    },
  });

  add({
    name: 'credentials',
    method: 'GET',
    pattern: /^\/api\/v1\/credentials$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => {
      const status = await ctx.deps.backend.credentials.status();
      return {
        status: 200,
        body: { claude: status.claude, openai_key: status.openaiKey, chatgpt_login: status.chatgptLogin },
      };
    },
  });

  // Secrets go in, never out: no response of these routes contains the value.
  add({
    name: 'credential_claude',
    method: 'POST',
    pattern: /^\/api\/v1\/credentials\/claude$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: secretBody,
    run: async (ctx) => {
      await ctx.deps.backend.credentials.saveClaude((ctx.body as { value: string }).value);
      return { status: 200, body: { saved: true } };
    },
  });

  add({
    name: 'credential_openai_key',
    method: 'POST',
    pattern: /^\/api\/v1\/credentials\/openai-key$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: secretBody,
    run: async (ctx) => {
      await ctx.deps.backend.credentials.saveOpenAiKey((ctx.body as { value: string }).value);
      return { status: 200, body: { saved: true } };
    },
  });

  add({
    name: 'credential_remove',
    method: 'DELETE',
    pattern: /^\/api\/v1\/credentials\/(claude|openai-key|chatgpt-login)$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      const kind = ctx.params[0];
      if (!isCredentialKind(kind)) throw new HttpError(400, 'invalid_request');
      // A credential the agents are using right now is not removed from under them.
      const status = await readModelStatus(ctx.deps.backend.model);
      const inUse = detectProvider(
        { OPENCODE_PROVIDER: status.provider, OPENCODE_BASE_URL: status.baseUrl, OPENCODE_AUTH_MODE: status.authMode },
        status.groups,
      );
      const used =
        (kind === 'claude' && inUse.kind === 'claude') ||
        (kind === 'openai-key' && inUse.kind === 'chatgpt' && inUse.auth === 'api-key') ||
        (kind === 'chatgpt-login' && inUse.kind === 'chatgpt' && inUse.auth === 'subscription');
      if (used) throw new HttpError(409, 'credential_in_use');
      await ctx.deps.backend.credentials.removeCredential(kind);
      return { status: 200, body: { removed: true } };
    },
  });

  const loginBody = (state: { state: string; url?: string; code?: string; error?: string }): unknown => ({
    state: state.state,
    ...(state.url ? { url: state.url } : {}),
    ...(state.code ? { code: state.code } : {}),
    ...(state.error ? { error: state.error } : {}),
  });

  add({
    name: 'chatgpt_login_start',
    method: 'POST',
    pattern: /^\/api\/v1\/credentials\/chatgpt\/login$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => ({ status: 202, body: loginBody(ctx.deps.backend.credentials.startChatgptLogin()) }),
  });

  add({
    name: 'chatgpt_login_state',
    method: 'GET',
    pattern: /^\/api\/v1\/credentials\/chatgpt\/login$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => ({ status: 200, body: loginBody(ctx.deps.backend.credentials.loginState()) }),
  });

  add({
    name: 'chatgpt_login_cancel',
    method: 'DELETE',
    pattern: /^\/api\/v1\/credentials\/chatgpt\/login$/,
    access: 'session',
    mutating: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      ctx.deps.backend.credentials.cancelChatgptLogin();
      return { status: 200, body: loginBody(ctx.deps.backend.credentials.loginState()) };
    },
  });

  add({
    name: 'backups',
    method: 'GET',
    pattern: /^\/api\/v1\/backups$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => ({ status: 200, body: { backups: ctx.deps.backend.backups.list().map(backupView) } }),
  });

  add({
    name: 'backup_create',
    method: 'POST',
    pattern: /^\/api\/v1\/backups$/,
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    // `force` is accepted and ignored: a backup always goes ahead once the wait for busy agents is over.
    parse: (raw) => fields<{ force?: boolean }>(raw, { force: { type: 'boolean', optional: true } }),
    run: async (ctx) => ({ status: 202, body: { job: jobView(ctx.deps.backupJobs.start(ctx.session!.id)) } }),
  });

  // The progress of the backup, and, once, its key (only to the session that started it). Polled by the page while a backup runs.
  add({
    name: 'backup_job',
    method: 'GET',
    pattern: /^\/api\/v1\/backups\/job$/,
    access: 'session',
    mutating: false,
    limit: 'read',
    parse: noBody,
    run: async (ctx) => ({ status: 200, body: { job: jobView(ctx.deps.backupJobs.status(ctx.session!.id)) } }),
  });

  add({
    name: 'backup_verify',
    method: 'POST',
    pattern: new RegExp(`^/api/v1/backups/${BACKUP_ID}/verify$`),
    access: 'session',
    mutating: true,
    limit: 'probe',
    parse: (raw) => fields<{ key: string }>(raw, { key: { type: 'string', max: 128 } }),
    run: async (ctx) => {
      const result = await ctx.deps.backend.backups.verify(ctx.params[0], (ctx.body as { key: string }).key);
      return {
        status: 200,
        body: {
          ok: true,
          entries: result.entries,
          files: result.files,
          bytes: result.bytes,
          release: result.manifest.source.version,
          consistency: result.manifest.consistency,
        },
      };
    },
  });

  add({
    name: 'backup_delete',
    method: 'DELETE',
    pattern: new RegExp(`^/api/v1/backups/${BACKUP_ID}$`),
    access: 'session',
    mutating: true,
    reauth: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      ctx.deps.backend.backups.delete(ctx.params[0]);
      return { status: 204 };
    },
  });

  add({
    name: 'backup_download',
    method: 'GET',
    pattern: new RegExp(`^/api/v1/backups/${BACKUP_ID}/download$`),
    access: 'session',
    mutating: false,
    reauth: true,
    limit: 'mutation',
    parse: noBody,
    run: async (ctx) => {
      const file = ctx.deps.backend.backups.fileFor(ctx.params[0]);
      return { status: 200, file: { path: file, filename: `${ctx.params[0]}.mbk` } };
    },
  });

  return routes;
}

function jobView(status: JobStatus): Record<string, unknown> {
  if (status.state === 'done') return { ...status, backup: backupView(status.backup) };
  return { ...status };
}

function backupView(record: {
  id: string;
  createdAt: string;
  bytes: number;
  release: string;
  consistency: string;
  machineIdentity: boolean;
  trigger?: string;
}): Record<string, unknown> {
  return {
    id: record.id,
    created_at: record.createdAt,
    bytes: record.bytes,
    release: record.release,
    consistency: record.consistency,
    machine_identity: record.machineIdentity,
    trigger: record.trigger === 'scheduled' ? 'scheduled' : 'manual',
  };
}

/** Turn anything a handler throws into a public error: a stable code, never internals. */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof AuthError) {
    return new HttpError(
      error.status,
      error.code,
      error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {},
    );
  }
  if (error instanceof BackupJobError) return new HttpError(409, error.code);
  if (error instanceof PhoneError) return new HttpError(409, error.code);
  if (error instanceof ModelSettingsError) {
    const status =
      error.code === 'invalid_input'
        ? 400
        : error.code === 'probe_failed'
          ? 422
          : error.code === 'change_in_progress'
            ? 409
            : 500;
    return new HttpError(status, error.code, {}, error.detail);
  }
  if (error instanceof CredentialError) {
    return new HttpError(
      error.code === 'invalid_secret'
        ? 400
        : error.code === 'runtime_unavailable' || error.code === 'script_missing'
          ? 503
          : 502,
      error.code,
    );
  }
  if (error instanceof BackupError) {
    return new HttpError(
      error.code === 'not_found' ? 404 : error.code === 'invalid_id' ? 400 : 409,
      error.code === 'agents_busy' ? 'agents_busy' : error.code,
    );
  }
  if (error instanceof CryptoError)
    return new HttpError(400, error.code === 'bad_key' ? 'invalid_key' : 'key_or_bundle_rejected');
  if (error instanceof InvalidBody) return new HttpError(400, 'invalid_request');
  return new HttpError(500, 'internal_error');
}
