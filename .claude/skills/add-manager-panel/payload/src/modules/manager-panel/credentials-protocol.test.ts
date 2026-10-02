import { describe, expect, it } from 'vitest';

import {
  encodeEvent,
  findAnthropicSecret,
  parseDeviceOutput,
  parseEvents,
  stripAnsi,
  validSecret,
} from './credentials-protocol.js';

// What `opencode auth login --provider openai --method "ChatGPT Pro/Plus (headless)"` printed on a real run.
const REAL_OUTPUT =
  '\u001b[0m┌  Add credential\n\u001b[0m\n│\n●  Go to: https://auth.openai.com/codex/device\n│\n●  Enter code: A34S-I4AT9\n\u001b[?25l│\n';

describe('parseDeviceOutput', () => {
  it('reads the page and the code from the real output, escape sequences and all', () => {
    expect(parseDeviceOutput(REAL_OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'A34S-I4AT9' });
  });
  it('waits for both parts and refuses anything that is not https', () => {
    expect(parseDeviceOutput('Go to: https://auth.openai.com/codex/device\n')).toBeNull();
    expect(parseDeviceOutput('Enter code: ABCD-1234\n')).toBeNull();
    expect(parseDeviceOutput('Go to: http://evil.test/x\nEnter code: ABCD-1234\n')).toBeNull();
    expect(parseDeviceOutput('')).toBeNull();
  });
  it('strips terminal escapes', () => {
    expect(stripAnsi('\u001b[1mbold\u001b[0m\u001b[?25l')).toBe('bold');
  });
});

describe('validSecret', () => {
  it('accepts single printable tokens of sensible length', () => {
    expect(validSecret('sk-ant-api03-' + 'a'.repeat(40))).toBe(true);
    expect(validSecret('x'.repeat(16))).toBe(true);
  });
  it.each([
    '',
    'short',
    'has space in it 1234567890',
    'new\nline-1234567890123',
    'tab\t1234567890123456',
    'x'.repeat(2000),
    'café-1234567890123456',
    42,
    null,
    undefined,
  ])('rejects %j', (value) => {
    expect(validSecret(value)).toBe(false);
  });
});

describe('findAnthropicSecret', () => {
  it('finds the stored Anthropic credential by type or name', () => {
    expect(
      findAnthropicSecret(
        JSON.stringify({
          data: [
            { id: 'a1', name: 'Other', type: 'generic' },
            { id: 'b2', name: 'Anthropic', type: 'anthropic' },
          ],
        }),
      ),
    ).toEqual({ id: 'b2' });
    expect(
      findAnthropicSecret(JSON.stringify({ data: [{ id: 'c3', name: 'my anthropic key', type: 'generic' }] })),
    ).toEqual({ id: 'c3' });
  });
  it('returns null when there is none, even for an empty or odd list', () => {
    expect(findAnthropicSecret(JSON.stringify({ data: [] }))).toBeNull();
    expect(
      findAnthropicSecret(JSON.stringify({ data: [{ id: 'z', name: 'OpenCode openai', type: 'generic' }] })),
    ).toBeNull();
    expect(findAnthropicSecret(JSON.stringify({}))).toBeNull();
  });
});

describe('events', () => {
  it('round-trips and ignores log noise, unknown shapes and unknown error codes', () => {
    const text = [
      'some log line',
      encodeEvent({ type: 'status', claude: true, openaiKey: false, chatgptLogin: true }).trim(),
      '{"type":"surprise"}',
      '{broken json',
      encodeEvent({ type: 'prompt', url: 'https://auth.example.test/device', code: 'AB-12' }).trim(),
      '{"type":"prompt","url":"http://insecure.test","code":"X"}',
      '{"type":"error","code":"not-a-known-code"}',
      encodeEvent({ type: 'done' }).trim(),
    ].join('\n');
    expect(parseEvents(text)).toEqual([
      { type: 'status', claude: true, openaiKey: false, chatgptLogin: true },
      { type: 'prompt', url: 'https://auth.example.test/device', code: 'AB-12' },
      { type: 'error', code: 'script_failed' },
      { type: 'done' },
    ]);
  });
});
