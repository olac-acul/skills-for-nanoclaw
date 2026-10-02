/**
 * Checks for an OpenAI-compatible model endpoint typed into the panel.
 *
 * The URL comes from the administrator's browser, so it is handled as
 * untrusted input: http(s) only, no credentials, query or fragment. The name
 * is resolved once and every address must be acceptable: loopback, private
 * LAN/VPN and unique-local addresses are fine for a local model server, public
 * addresses are fine over HTTPS (a hosted provider), and link-local (cloud
 * metadata), multicast, reserved and unspecified addresses are refused. Plain
 * HTTP is only accepted for local addresses. The request goes to the address
 * that was checked (no second lookup), follows no redirects, sends no
 * credentials and reads a bounded body. Nothing about the endpoint is logged;
 * callers get a result code.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** Networks that are reachable only from this host or its LAN/VPN. */
function localRanges(): net.BlockList {
  const list = new net.BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  // Private IPv4 ranges written as numbers so no dotted private address literal is needed in the source.
  for (const [first, second, prefix] of [
    [10, 0, 8],
    [172, 16, 12],
    [192, 168, 16],
    [100, 64, 10],
  ]) {
    list.addSubnet(`${first}.${second}.0.0`, prefix, 'ipv4');
  }
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  return list;
}

/** Never acceptable, local or not. */
function blockedRanges(): net.BlockList {
  const list = new net.BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, includes cloud metadata services
  list.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
  list.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved and broadcast
  list.addAddress('::', 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('ff00::', 8, 'ipv6');
  return list;
}

export type AddressClass = 'blocked' | 'local' | 'public';

/** Unwrap `::ffff:a.b.c.d` so IPv4-mapped addresses are judged as IPv4. */
function unmap(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return { address: mapped[1], family: 'ipv4' };
  return { address, family: net.isIPv6(address) ? 'ipv6' : 'ipv4' };
}

export function classifyAddress(
  raw: string,
  ranges = { blocked: blockedRanges(), local: localRanges() },
): AddressClass {
  const { address, family } = unmap(raw);
  if (ranges.blocked.check(address, family)) return 'blocked';
  return ranges.local.check(address, family) ? 'local' : 'public';
}

export type ProbeRequest = (
  target: URL,
  address: string,
  family: number,
  init: { method: 'GET' | 'POST'; body?: string; timeoutMs: number },
) => Promise<{ status: number; body: unknown }>;

export interface EndpointDeps {
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: ProbeRequest;
}

export type EndpointCheck =
  | { ok: true; url: URL; address: string; family: number; local: boolean }
  | { ok: false; reason: 'endpoint_invalid' | 'endpoint_not_allowed' | 'endpoint_insecure' | 'endpoint_unresolvable' };

const MAX_BODY = 256 * 1024;

export async function checkEndpoint(raw: string, deps: EndpointDeps): Promise<EndpointCheck> {
  let url: URL;
  try {
    url = new URL(raw);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a malformed URL is reported as a result code
  } catch {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.length > 2048
  ) {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string; family: number }>;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      addresses = await deps.lookup(host);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed lookup is reported as a result code
    } catch {
      return { ok: false, reason: 'endpoint_unresolvable' };
    }
    if (addresses.length === 0) return { ok: false, reason: 'endpoint_unresolvable' };
  }
  const classes = addresses.map(({ address }) => classifyAddress(address));
  if (classes.includes('blocked')) return { ok: false, reason: 'endpoint_not_allowed' };
  const local = classes.every((kind) => kind === 'local');
  // Credentials and prompts would cross the internet in clear text.
  if (url.protocol === 'http:' && !local) return { ok: false, reason: 'endpoint_insecure' };
  return { ok: true, url, address: addresses[0].address, family: addresses[0].family, local };
}

/** One HTTP exchange with the checked address, no redirects, bounded body, hard deadline. */
export const pinnedRequest: ProbeRequest = (target, address, family, init) =>
  new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(
      target,
      {
        method: init.method,
        agent: false,
        headers: {
          accept: 'application/json',
          'user-agent': 'manager-panel-probe',
          ...(init.body !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(init.body) }
            : {}),
        },
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }) as unknown as net.LookupFunction,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY) request.destroy(new Error('body_too_large'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable response body is treated as no body
          } catch {
            body = null;
          }
          resolve({ status: response.statusCode ?? 0, body });
        });
        response.on('error', reject);
      },
    );
    const timer = setTimeout(() => request.destroy(new Error('timeout')), init.timeoutMs);
    timer.unref();
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(init.body);
  });

export function liveEndpointDeps(): EndpointDeps {
  return {
    lookup: (hostname) => dns.lookup(hostname, { all: true, verbatim: true }),
    request: pinnedRequest,
  };
}

export interface ProbeResult {
  /** Null when the endpoint serves the model; otherwise a stable code. */
  reason: string | null;
  /** Model IDs the endpoint lists, bounded; empty when it could not be read. */
  models: string[];
  /** The model's context window when the endpoint reports one (vLLM `max_model_len`). */
  contextLimit: number | null;
  /** True when the endpoint is on this host or its LAN/VPN. */
  local: boolean;
}

function failure(error: unknown): string {
  const code = (error as { code?: string }).code ?? '';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return 'endpoint_tls_failed';
  return 'endpoint_unreachable';
}

function join(base: URL, suffix: string): URL {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
  return url;
}

/**
 * Check an OpenAI-compatible endpoint: address rules, `/models`, and — when a
 * model is given — that it is listed and answers a one-token completion.
 * A keyless endpoint is assumed; an endpoint that wants a key reports
 * `endpoint_unauthorized`.
 */
export async function probeEndpoint(
  raw: string,
  model: string | null,
  deps: EndpointDeps,
  timeouts = { list: 5_000, inference: 12_000 },
): Promise<ProbeResult> {
  const checked = await checkEndpoint(raw, deps);
  if (!checked.ok) return { reason: checked.reason, models: [], contextLimit: null, local: false };
  const base = { models: [] as string[], contextLimit: null as number | null, local: checked.local }; // privacy-scan: allow -- property name or synthetic test input
  let listed: { status: number; body: unknown };
  try {
    listed = await deps.request(join(checked.url, '/models'), checked.address, checked.family, {
      method: 'GET',
      timeoutMs: timeouts.list,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- a failed request is reported as a result code
  } catch (error) {
    return { ...base, reason: failure(error) };
  }
  if (listed.status === 401 || listed.status === 403) return { ...base, reason: 'endpoint_unauthorized' };
  const data = (listed.body as { data?: unknown } | null)?.data;
  if (listed.status !== 200 || !Array.isArray(data)) return { ...base, reason: 'endpoint_invalid_response' };
  const entries = data
    .filter((item): item is { id: string; max_model_len?: unknown } => typeof item?.id === 'string')
    .slice(0, 200);
  const models = entries.map((item) => item.id);
  if (model === null) return { ...base, reason: null, models };

  const entry = entries.find((item) => item.id === model);
  if (!entry) return { ...base, reason: 'model_not_found', models };
  const window = entry.max_model_len;
  const contextLimit = typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? window : null;
  try {
    const answer = await deps.request(join(checked.url, '/chat/completions'), checked.address, checked.family, {
      method: 'POST',
      timeoutMs: timeouts.inference,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    const choices = (answer.body as { choices?: unknown } | null)?.choices;
    if (answer.status !== 200 || !Array.isArray(choices))
      return { ...base, reason: 'inference_failed', models, contextLimit };
    // eslint-disable-next-line no-catch-all/no-catch-all -- a failed request is reported as a result code
  } catch (error) {
    return {
      ...base,
      reason: failure(error) === 'endpoint_tls_failed' ? 'endpoint_tls_failed' : 'inference_failed',
      models,
      contextLimit,
    };
  }
  return { ...base, reason: null, models, contextLimit };
}
