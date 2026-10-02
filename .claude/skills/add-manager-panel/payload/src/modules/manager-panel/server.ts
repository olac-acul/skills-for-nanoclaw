/**
 * The panel's HTTP server: transport and security around `routes.ts`.
 *
 * Every request goes through the same steps:
 *  0. connections from public internet addresses are refused (unless configured otherwise);
 *  1. the Host must be a local or explicitly allowed name (defeats DNS rebinding);
 *  2. a cross-site `Sec-Fetch-Site` is refused;
 *  3. the route is matched (anything else is `not_found`);
 *  4. a session cookie is required for everything but health, setup and login;
 *  5. state changes need an `Origin` equal to the panel's own origin and the CSRF token;
 *  6. sensitive routes need the password re-entered recently;
 *  7. a per-minute limit applies per session (or per address before login);
 *  8. the JSON body is parsed under a size cap and validated to an exact shape.
 * Responses are `no-store` JSON with a strict CSP. Errors carry a stable code
 * and a request id, never a stack, path or value. State changes are audited
 * without bodies.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { classifyAddress } from './model-endpoint.js';
import { Auth } from './auth.js';
import type { PanelBackend } from './backend.js';
import {
  HttpError,
  buildRoutes,
  toHttpError,
  type LimitClass,
  type Reply,
  type Route,
  type RouteDeps,
} from './routes.js';
import type { ScryptParams } from './password.js';
import type { Session } from './sessions.js';
import type { PanelState } from './state.js';
import { APP_CSS, APP_JS, INDEX_HTML, UI_CSP } from './ui.js';

export const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 30_000;
const COOKIE_SECURE = '__Host-manager_panel';
const COOKIE_PLAIN = 'manager_panel';
const RATE_LIMITS: Readonly<Record<LimitClass, number>> = { read: 240, mutation: 30, probe: 30, login: 20 };

const API_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export interface PanelServerConfig {
  state: PanelState;
  backend: PanelBackend;
  /** Serve over HTTPS directly (certificate and key), or sit behind a TLS-terminating proxy. */
  tls?: { cert: Buffer; key: Buffer };
  /** Exact origin the browser uses, when it differs from the Host header (behind a proxy). */
  publicOrigin?: string;
  /** Host names accepted besides local ones (comma list from configuration). */
  allowedHosts?: string[];
  /** Milliseconds a hot backup waits for running agents. */
  backupWaitMs?: number;
  /** Refuse connections from public internet addresses (default true). */
  lanOnly?: boolean;
  /** Called with the real error behind every 500, which the browser never sees. */
  onError?: (error: unknown) => void;
  now?: () => number;
  scrypt?: ScryptParams;
}

/** Names that cannot be reached by a remote attacker's DNS: loopback, IP literals and LAN-only labels. */
export function hostAllowed(hostHeader: string | undefined, extra: readonly string[]): boolean {
  if (!hostHeader || hostHeader.length > 255) return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
  const name = (bracketed ? bracketed[1] : hostHeader.replace(/:\d+$/, '')).toLowerCase();
  if (net.isIP(name)) return true;
  if (extra.some((allowed) => allowed.toLowerCase() === name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (!name.includes('.')) return /^[a-z0-9-]+$/.test(name); // single-label LAN name
  return /\.(?:local|lan|internal|home\.arpa)$/.test(name);
}

/** Connections from public internet addresses are refused unless the operator opted in. */
export function networkAllowed(remoteAddress: string | undefined, lanOnly: boolean): boolean {
  return !lanOnly || classifyAddress(remoteAddress ?? '') !== 'public';
}

function cookieValue(request: http.IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.on('error', () => reject(new HttpError(400, 'invalid_request')));
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'payload_too_large'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      reject(new HttpError(408, 'request_timeout'));
      request.destroy();
    }, BODY_TIMEOUT_MS);
    request.on('close', () => clearTimeout(timer));
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(new HttpError(413, 'payload_too_large'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      clearTimeout(timer);
      if (size === 0) return resolve(undefined);
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(request.headers['content-type'] ?? ''))) {
        return reject(new HttpError(415, 'unsupported_media_type'));
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed body is reported as a client error
      } catch {
        reject(new HttpError(400, 'invalid_request'));
      }
    });
  });
}

export function createPanelServer(config: PanelServerConfig): http.Server {
  const now = config.now ?? Date.now;
  const auth = new Auth(config.state, now, config.scrypt);
  const routes = buildRoutes();
  const secure = Boolean(config.tls) || config.publicOrigin?.startsWith('https:') === true;
  const cookieName = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  const attributes = secure ? 'Path=/; Secure; HttpOnly; SameSite=Strict' : 'Path=/; HttpOnly; SameSite=Strict';
  const headers: Record<string, string> = secure
    ? { ...API_HEADERS, 'strict-transport-security': 'max-age=31536000' }
    : { ...API_HEADERS };
  const allowedHosts = config.allowedHosts ?? [];
  const windows = new Map<string, { start: number; count: number }>();

  const deps: RouteDeps = {
    backend: config.backend,
    auth,
    state: config.state,
    insecureHttp: !secure,
    setCookie: (token) => `${cookieName}=${token}; ${attributes}`,
    clearCookie: () => `${cookieName}=; ${attributes}; Max-Age=0`,
    backupWaitMs: config.backupWaitMs ?? 120_000,
  };

  function limit(key: string, kind: LimitClass): void {
    const at = now();
    const bucket = windows.get(`${kind}:${key}`);
    if (!bucket || at - bucket.start >= 60_000) {
      windows.set(`${kind}:${key}`, { start: at, count: 1 });
      if (windows.size > 2048) windows.clear();
      return;
    }
    bucket.count += 1;
    if (bucket.count > RATE_LIMITS[kind]) throw new HttpError(429, 'rate_limited', { 'retry-after': '60' });
  }

  function expectedOrigin(request: http.IncomingMessage): string {
    return config.publicOrigin ?? `${secure ? 'https' : 'http'}://${request.headers.host}`;
  }

  function match(method: string, pathname: string): { route: Route; params: string[] } | null {
    for (const route of routes) {
      if (route.method !== method) continue;
      const found = route.pattern.exec(pathname);
      if (found) return { route, params: found.slice(1) };
    }
    return null;
  }

  async function handleApi(request: http.IncomingMessage, url: URL, seen: { route: Route | null }): Promise<Reply> {
    const method = request.method ?? 'GET';
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new HttpError(405, 'method_not_allowed');
    const found = match(method, url.pathname);
    if (!found) throw new HttpError(404, 'not_found');
    const { route, params } = found;
    seen.route = route; // set early so failed attempts are audited too

    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'cross_site_request');
    if (route.mutating && request.headers.origin !== expectedOrigin(request))
      throw new HttpError(403, 'origin_mismatch');

    const token = cookieValue(request, cookieName);
    let session: Session | null = null;
    if (route.access === 'session') {
      session = auth.sessions.get(token, auth.generation());
      if (!session) throw new HttpError(401, 'unauthenticated');
      if (
        route.mutating &&
        !auth.sessions.csrfMatches(session, request.headers['x-csrf-token'] as string | undefined)
      ) {
        throw new HttpError(403, 'csrf_mismatch');
      }
      if (route.reauth && !auth.sessions.hasReauth(session)) throw new HttpError(403, 'reauth_required');
    }
    limit(session ? session.csrf.slice(0, 16) : (request.socket.remoteAddress ?? 'unknown'), route.limit);

    const body = route.method === 'GET' ? route.parse(undefined) : route.parse(await readBody(request));
    return route.run({ params, body, session, token, deps });
  }

  function sendJson(
    response: http.ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void {
    response.writeHead(status, { ...headers, ...extra });
    response.end(status === 204 || body === undefined ? undefined : JSON.stringify(body));
  }

  function sendStatic(response: http.ServerResponse, type: string, body: string): void {
    response.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy': UI_CSP,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    });
    response.end(body);
  }

  const listener: http.RequestListener = (request, response) => {
    const id = `req_${randomBytes(8).toString('hex')}`;
    void (async () => {
      const seen: { route: Route | null } = { route: null };
      let status = 500;
      try {
        if (!networkAllowed(request.socket.remoteAddress, config.lanOnly !== false))
          throw new HttpError(403, 'network_not_allowed');
        if (!hostAllowed(request.headers.host, allowedHosts)) throw new HttpError(421, 'host_not_allowed');
        const url = new URL(request.url ?? '/', 'http://panel.invalid');
        if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
          if (url.pathname === '/' || url.pathname === '/index.html')
            sendStatic(response, 'text/html; charset=utf-8', INDEX_HTML);
          else if (url.pathname === '/app.js') sendStatic(response, 'text/javascript; charset=utf-8', APP_JS);
          else if (url.pathname === '/app.css') sendStatic(response, 'text/css; charset=utf-8', APP_CSS);
          else throw new HttpError(404, 'not_found');
          return;
        }
        const reply = await handleApi(request, url, seen);
        status = reply.status;
        if (reply.file) {
          const size = fs.statSync(reply.file.path).size;
          response.writeHead(200, {
            ...headers,
            'content-type': 'application/octet-stream',
            'content-length': String(size),
            'content-disposition': `attachment; filename="${reply.file.filename}"`,
          });
          fs.createReadStream(reply.file.path)
            .on('error', () => response.destroy())
            .pipe(response);
        } else {
          sendJson(response, reply.status, reply.body, reply.headers);
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- auditing must never break a request that already finished
      } catch (error) {
        const failure = toHttpError(error);
        status = failure.status;
        if (failure.status >= 500) config.onError?.(error);
        sendJson(
          response,
          failure.status,
          { error: { code: failure.code, request_id: id, ...(failure.detail ? { detail: failure.detail } : {}) } },
          failure.headers,
        );
      } finally {
        if (seen.route?.mutating) {
          try {
            config.state.audit({
              at: new Date(now()).toISOString(),
              endpoint: seen.route.name,
              status,
              request_id: id,
            });
            // eslint-disable-next-line no-catch-all/no-catch-all -- every error is mapped to a public code; the cause goes to onError
          } catch {
            // Auditing must never break a request that already finished.
          }
        }
      }
    })();
  };

  const server = config.tls
    ? https.createServer({ cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2' }, listener)
    : http.createServer(listener);
  server.headersTimeout = 15_000;
  server.requestTimeout = 0; // downloads may be long; JSON bodies have their own deadline
  server.keepAliveTimeout = 5_000;
  return server;
}
