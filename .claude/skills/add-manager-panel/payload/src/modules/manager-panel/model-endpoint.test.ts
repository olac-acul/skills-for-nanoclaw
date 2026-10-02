import { describe, expect, it } from 'vitest';

import {
  checkEndpoint,
  classifyAddress,
  probeEndpoint,
  type EndpointDeps,
  type ProbeRequest,
} from './model-endpoint.js';

// Addresses are assembled from parts so no private address literal sits in the source.
const ip = (...parts: number[]): string => parts.join('.');

function deps(table: Record<string, string[]>, request?: ProbeRequest): EndpointDeps {
  return {
    lookup: async (host) => {
      const found = table[host];
      if (!found) throw new Error('ENOTFOUND');
      return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    request: request ?? (async () => ({ status: 200, body: null })),
  };
}

describe('classifyAddress', () => {
  it.each([
    [ip(127, 0, 0, 1), 'local'],
    ['::1', 'local'],
    [ip(10, 1, 2, 3), 'local'],
    [ip(172, 16, 0, 9), 'local'],
    [ip(192, 168, 1, 5), 'local'],
    [ip(100, 64, 0, 1), 'local'],
    ['fd12:3456::1', 'local'],
    [ip(8, 8, 8, 8), 'public'],
    ['2606:4700::1111', 'public'],
    [ip(172, 32, 0, 1), 'public'],
    [ip(169, 254, 169, 254), 'blocked'],
    [ip(0, 0, 0, 0), 'blocked'],
    [ip(224, 0, 0, 1), 'blocked'],
    [ip(255, 255, 255, 255), 'blocked'],
    ['fe80::1', 'blocked'],
    ['::', 'blocked'],
    ['::ffff:' + ip(169, 254, 169, 254), 'blocked'],
    ['::ffff:' + ip(127, 0, 0, 1), 'local'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('checkEndpoint', () => {
  const table = {
    'models.test': [ip(192, 168, 1, 20)],
    'api.test': [ip(8, 8, 4, 4)],
    'meta.test': [ip(169, 254, 169, 254)],
    'mixed.test': [ip(8, 8, 4, 4), ip(10, 0, 0, 5)],
  };

  it('accepts a local server over plain HTTP, including localhost and bare names', async () => {
    expect(await checkEndpoint('http://models.test:8000/v1', deps(table))).toMatchObject({ ok: true, local: true });
    expect(await checkEndpoint(`http://${ip(127, 0, 0, 1)}:8000/v1`, deps(table))).toMatchObject({
      ok: true,
      local: true,
    });
    expect(await checkEndpoint('http://llm-box:8000/v1', deps({ 'llm-box': [ip(10, 0, 0, 7)] }))).toMatchObject({
      ok: true,
    });
  });

  it('accepts a public host over HTTPS only', async () => {
    expect(await checkEndpoint('https://api.test/v1', deps(table))).toMatchObject({ ok: true, local: false });
    expect(await checkEndpoint('http://api.test/v1', deps(table))).toEqual({ ok: false, reason: 'endpoint_insecure' });
  });

  it('refuses metadata, multicast and any name that resolves partly to a blocked address', async () => {
    expect(await checkEndpoint('http://meta.test/v1', deps(table))).toEqual({
      ok: false,
      reason: 'endpoint_not_allowed',
    });
    expect(await checkEndpoint(`http://${ip(169, 254, 169, 254)}/latest`, deps(table))).toEqual({
      ok: false,
      reason: 'endpoint_not_allowed',
    });
    // A mix of public and local answers is treated as public: HTTP is refused.
    expect(await checkEndpoint('http://mixed.test/v1', deps(table))).toEqual({
      ok: false,
      reason: 'endpoint_insecure',
    });
  });

  it.each([
    'not a url',
    'ftp://models.test/v1',
    'http://user:pass@models.test/v1',
    'http://models.test/v1?x=1',
    'http://models.test/v1#frag',
    `http://models.test/${'a'.repeat(3000)}`,
  ])('rejects malformed endpoint %#', async (raw) => {
    expect(await checkEndpoint(raw, deps(table))).toEqual({ ok: false, reason: 'endpoint_invalid' });
  });

  it('reports unresolvable names', async () => {
    expect(await checkEndpoint('http://nowhere.test/v1', deps(table))).toEqual({
      ok: false,
      reason: 'endpoint_unresolvable',
    });
  });
});

describe('probeEndpoint', () => {
  const table = { 'models.test': [ip(192, 168, 1, 20)] };
  const answers =
    (handlers: Record<string, { status: number; body: unknown } | Error>): ProbeRequest =>
    async (target) => {
      const handler = handlers[target.pathname];
      if (!handler) return { status: 404, body: null };
      if (handler instanceof Error) throw handler;
      return handler;
    };

  it('lists models and reads the context window', async () => {
    const request = answers({
      '/v1/models': { status: 200, body: { data: [{ id: 'a', max_model_len: 8192 }, { id: 'b' }, { nope: true }] } },
      '/v1/chat/completions': { status: 200, body: { choices: [{}] } },
    });
    expect(await probeEndpoint('http://models.test/v1', null, deps(table, request))).toMatchObject({
      reason: null,
      models: ['a', 'b'],
    });
    expect(await probeEndpoint('http://models.test/v1', 'a', deps(table, request))).toMatchObject({
      reason: null,
      contextLimit: 8192,
    });
    expect(await probeEndpoint('http://models.test/v1', 'b', deps(table, request))).toMatchObject({
      reason: null,
      contextLimit: null,
    });
  });

  it.each([
    ['unknown model', { '/v1/models': { status: 200, body: { data: [{ id: 'a' }] } } }, 'zzz', 'model_not_found'],
    ['unauthorized', { '/v1/models': { status: 401, body: null } }, 'a', 'endpoint_unauthorized'],
    [
      'not an OpenAI-style answer',
      { '/v1/models': { status: 200, body: { hello: 1 } } },
      'a',
      'endpoint_invalid_response',
    ],
    ['server error', { '/v1/models': { status: 500, body: null } }, 'a', 'endpoint_invalid_response'],
    ['connection refused', { '/v1/models': new Error('ECONNREFUSED') }, 'a', 'endpoint_unreachable'],
    [
      'completion fails',
      {
        '/v1/models': { status: 200, body: { data: [{ id: 'a' }] } },
        '/v1/chat/completions': { status: 500, body: null },
      },
      'a',
      'inference_failed',
    ],
  ])('%s', async (_label, handlers, model, reason) => {
    const result = await probeEndpoint('http://models.test/v1', model, deps(table, answers(handlers as never)));
    expect(result.reason).toBe(reason);
  });

  it('maps TLS failures to their own code and never calls out for a refused address', async () => {
    const tls = Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const request = answers({ '/v1/models': tls });
    expect((await probeEndpoint('https://models.test/v1', 'a', deps(table, request))).reason).toBe(
      'endpoint_tls_failed',
    );
    let called = false;
    const spy: ProbeRequest = async () => {
      called = true;
      return { status: 200, body: null };
    };
    const blocked = await probeEndpoint(`http://${ip(169, 254, 169, 254)}/v1`, 'a', deps(table, spy));
    expect(blocked.reason).toBe('endpoint_not_allowed');
    expect(called).toBe(false);
  });
});
