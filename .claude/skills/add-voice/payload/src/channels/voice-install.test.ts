import { describe, expect, it } from 'vitest';

import {
  SECTION_BEGIN,
  SECTION_END,
  generateToken,
  mergeSection,
  pairingAddress,
  readEnvValue,
  readSettings,
  removeSection,
  upsertEnv,
  validBindHost,
  validToken,
} from './voice-install.js';

describe('tokens', () => {
  it('makes distinct tokens that pass the check', () => {
    const a = generateToken();
    expect(a).toHaveLength(48);
    expect(validToken(a)).toBe(true);
    expect(generateToken()).not.toBe(a);
  });
  it('refuses short or odd tokens', () => {
    expect(validToken('short')).toBe(false);
    expect(validToken(`${'a'.repeat(30)} b`)).toBe(false);
  });
});

describe('upsertEnv', () => {
  it('sets, replaces and removes keys and keeps everything else', () => {
    const before = '# keep me\nA=1\nVOICE_ENABLED=false\nZ=last\n';
    const after = upsertEnv(before, { VOICE_ENABLED: 'true', VOICE_BIND_HOST: '100.64.0.9', A: null });
    expect(after).toBe('# keep me\nVOICE_ENABLED=true\nZ=last\nVOICE_BIND_HOST=100.64.0.9\n');
  });
  it('writes to the last of a repeated key', () => {
    expect(upsertEnv('K=1\nK=2\n', { K: '3' })).toBe('K=1\nK=3\n');
  });
  it('starts a file from nothing', () => {
    expect(upsertEnv('', { K: 'v' })).toBe('K=v\n');
  });
  it('refuses a bad name or a value with a line break', () => {
    expect(() => upsertEnv('', { 'bad name': 'v' })).toThrow();
    expect(() => upsertEnv('', { K: 'a\nINJECT=1' })).toThrow();
  });
  it('reads a value, quotes removed', () => {
    expect(readEnvValue('K="x y"\n', 'K')).toBe('x y');
    expect(readEnvValue('A=1\n', 'K')).toBeUndefined();
  });
});

describe('the instructions section', () => {
  const section = '## Canale voce\n\nTesto.';
  it("is appended after the group's own instructions", () => {
    const merged = mergeSection('# Assistant\n\nOwn text.\n', section);
    expect(merged.startsWith('# Assistant\n\nOwn text.\n\n')).toBe(true);
    expect(merged).toContain(SECTION_BEGIN);
    expect(merged.endsWith(`${SECTION_END}\n`)).toBe(true);
  });
  it('replaces only its own block on a second run, whatever surrounds it', () => {
    const first = mergeSection('# A\n\nBefore.\n', section);
    const withTail = `${first}\n## After\n\nTail.\n`;
    const second = mergeSection(withTail, '## Canale voce\n\nNuovo testo.');
    expect(second).toContain('Nuovo testo.');
    expect(second).not.toContain('\nTesto.');
    expect(second).toContain('Before.');
    expect(second).toContain('## After\n\nTail.');
    expect(second.split(SECTION_BEGIN).length).toBe(2);
  });
  it('is stable: merging the same text twice gives the same file', () => {
    const once = mergeSection('# A\n', section);
    expect(mergeSection(once, section)).toBe(once);
  });
  it('writes a new file when there is none', () => {
    expect(mergeSection('', section)).toBe(`${SECTION_BEGIN}\n${section}\n${SECTION_END}\n`);
  });
  it('refuses half a block rather than guess', () => {
    expect(() => mergeSection(`${SECTION_BEGIN}\nno end`, section)).toThrow(/end marker/);
    expect(() => mergeSection(`text\n${SECTION_END}`, section)).toThrow(/begin marker/);
  });
  it('removes its block and nothing else', () => {
    const merged = mergeSection('# A\n\nBefore.\n', section);
    expect(removeSection(merged)).toBe('# A\n\nBefore.\n');
    expect(removeSection('# A\n')).toBe('# A\n');
  });
});

describe('addresses', () => {
  it('reads the settings with defaults', () => {
    expect(readSettings('')).toEqual({ enabled: false, host: '127.0.0.1', port: 8767, hasToken: false });
    expect(
      readSettings(
        `VOICE_ENABLED=true\nVOICE_BIND_HOST=100.64.0.9\nVOICE_CHANNEL_PORT=9000\nVOICE_AUTH_TOKEN=${'a'.repeat(48)}\n`,
      ),
    ).toEqual({
      enabled: true,
      host: '100.64.0.9',
      port: 9000,
      hasToken: true,
    });
  });
  it('gives the phone an address, or says why not', () => {
    expect(pairingAddress({ enabled: true, host: '100.64.0.9', port: 8767, hasToken: true })).toEqual({
      url: 'ws://100.64.0.9:8767',
    });
    expect(pairingAddress({ enabled: true, host: '0.0.0.0', port: 8767, hasToken: true }, 'nas.test')).toEqual({
      url: 'ws://nas.test:8767',
    });
    expect(pairingAddress({ enabled: true, host: 'fd7a::1', port: 8767, hasToken: true })).toEqual({
      url: 'ws://[fd7a::1]:8767',
    });
    expect('problem' in pairingAddress({ enabled: true, host: '127.0.0.1', port: 8767, hasToken: true })).toBe(true);
    expect('problem' in pairingAddress({ enabled: true, host: '0.0.0.0', port: 8767, hasToken: true })).toBe(true);
  });
  it('checks a bind address', () => {
    for (const ok of ['100.64.0.9', 'fd7a::1', 'phone-server', 'a.b.test']) expect(validBindHost(ok), ok).toBe(true);
    for (const bad of ['', '999.1.1.1', 'a b', 'x;rm', '-bad']) expect(validBindHost(bad), bad).toBe(false);
  });
});
