import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PAIRING_TTL_MS,
  PhoneError,
  addressFor,
  createPhonePort,
  makePairingCode,
  pairingLink,
  readRecordedStatus,
  type PhoneOptions,
} from './phone.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-phone-'));
  fs.mkdirSync(path.join(root, 'data'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const TOKEN = 'a'.repeat(48);
const env = (lines: string[]) => fs.writeFileSync(path.join(root, '.env'), `${lines.join('\n')}\n`);
const readEnv = () => fs.readFileSync(path.join(root, '.env'), 'utf8');
const status = (data: unknown) => fs.writeFileSync(path.join(root, 'data', 'voice-status.json'), JSON.stringify(data));
const port = (over: Partial<PhoneOptions> = {}) =>
  createPhonePort({ projectRoot: root, installed: () => true, wiredAgents: async () => ['Alpha'], ...over });

describe('addressFor', () => {
  it('gives the phone an address, or the reason there is none', () => {
    expect(addressFor('100.64.0.9', 8767)).toEqual({ url: 'ws://100.64.0.9:8767', problem: null });
    expect(addressFor('fd7a::1', 9000)).toEqual({ url: 'ws://[fd7a::1]:9000', problem: null });
    expect(addressFor('127.0.0.1', 8767)).toEqual({ url: null, problem: 'loopback' });
    expect(addressFor('localhost', 8767)).toEqual({ url: null, problem: 'loopback' });
    expect(addressFor('0.0.0.0', 8767)).toEqual({ url: null, problem: 'all_addresses' });
  });
});

describe('readRecordedStatus', () => {
  const file = () => path.join(root, 'data', 'voice-status.json');
  it('reads the channel file and checks every field', () => {
    status({
      listening: true,
      connected: true,
      connectedAt: '2026-10-02T12:00:00.000Z',
      lastDisconnectAt: null,
      locale: 'it-IT',
    });
    expect(readRecordedStatus(file())).toEqual({
      listening: true,
      connected: true,
      connectedAt: '2026-10-02T12:00:00.000Z',
      lastDisconnectAt: null,
      pairedAt: null,
      pairedDevice: null,
      locale: 'it-IT',
    });
  });
  it('reads when and by which device the app paired, and drops a device name that is not plain', () => {
    status({ pairedAt: '2026-10-02T12:00:00.000Z', pairedDevice: 'Pixel 8' });
    expect(readRecordedStatus(file())).toMatchObject({ pairedAt: '2026-10-02T12:00:00.000Z', pairedDevice: 'Pixel 8' });
    status({ pairedAt: '2026-10-02T12:00:00.000Z', pairedDevice: '<b>x</b>' });
    expect(readRecordedStatus(file())?.pairedDevice).toBeNull();
  });
  it('treats a missing, damaged or odd file as no status, and drops values of the wrong shape', () => {
    expect(readRecordedStatus(file())).toBeNull();
    fs.writeFileSync(file(), 'not json');
    expect(readRecordedStatus(file())).toBeNull();
    status('text');
    expect(readRecordedStatus(file())).toBeNull();
    status({ listening: 'yes', connected: 1, connectedAt: 'yesterday', locale: '<script>' });
    expect(readRecordedStatus(file())).toEqual({
      listening: false,
      connected: false,
      connectedAt: null,
      lastDisconnectAt: null,
      pairedAt: null,
      pairedDevice: null,
      locale: null,
    });
  });
});

describe('the phone port', () => {
  it('reports a channel that is on, listening and connected', async () => {
    env([`VOICE_ENABLED=true`, `VOICE_AUTH_TOKEN=${TOKEN}`, 'VOICE_BIND_HOST=100.64.0.9']);
    status({
      listening: true,
      connected: true,
      connectedAt: '2026-10-02T12:00:00.000Z',
      lastDisconnectAt: null,
      locale: 'it-IT',
    });
    fs.writeFileSync(path.join(root, 'data', 'voice-push.json'), '{}');
    expect(await port().status()).toEqual({
      installed: true,
      enabled: true,
      listening: true,
      connected: true,
      connectedAt: '2026-10-02T12:00:00.000Z',
      lastDisconnectAt: null,
      locale: 'it-IT',
      url: 'ws://100.64.0.9:8767',
      addressProblem: null,
      tokenSet: true,
      pushRegistered: true,
      agent: 'Alpha',
      restartNeeded: false,
      pairedAt: null,
      pairedDevice: null,
      pairingPending: false,
    });
  });

  it('does not say connected when the setting is off, even if an old file does', async () => {
    env(['VOICE_ENABLED=false', `VOICE_AUTH_TOKEN=${TOKEN}`]);
    status({
      listening: true,
      connected: true,
      connectedAt: '2026-10-02T12:00:00.000Z',
      lastDisconnectAt: null,
      locale: 'it-IT',
    });
    const s = await port().status();
    expect(s).toMatchObject({ enabled: false, listening: false, connected: false, connectedAt: null, locale: null });
    expect(s.restartNeeded).toBe(true); // the file says it still runs
  });

  it('asks for a restart when the setting is on and the channel is not running', async () => {
    env(['VOICE_ENABLED=true', `VOICE_AUTH_TOKEN=${TOKEN}`]);
    expect(await port().status()).toMatchObject({ enabled: true, listening: false, restartNeeded: true });
  });

  it('does not look at the agents or ask for a restart when the channel is not installed', async () => {
    env([]);
    let asked = false;
    const s = await port({ installed: () => false, wiredAgents: async () => ((asked = true), ['x']) }).status();
    expect(asked).toBe(false);
    expect(s).toMatchObject({ installed: false, agent: null, restartNeeded: false, tokenSet: false });
  });

  it('makes a token that the channel accepts, stores it, keeps other settings, and returns it only to the caller', async () => {
    env(['# mine', 'OTHER=1', 'VOICE_ENABLED=true']);
    const token = await port().newToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(readEnv()).toContain(`VOICE_AUTH_TOKEN=${token}`);
    expect(readEnv()).toContain('# mine');
    expect(readEnv()).toContain('OTHER=1');
    expect(JSON.stringify(await port().status())).not.toContain(token);
    expect(await port().newToken()).not.toBe(token);
    expect(fs.statSync(path.join(root, '.env')).mode & 0o077).toBe(0);
  });

  it('turns the channel on only when there is a token, and off any time', async () => {
    env([]);
    await expect(port().setEnabled(true)).rejects.toMatchObject({ code: 'token_missing' });
    expect(readEnv()).not.toContain('VOICE_ENABLED=true');
    await port().newToken();
    await port().setEnabled(true);
    expect(readEnv()).toContain('VOICE_ENABLED=true');
    await port().setEnabled(false);
    expect(readEnv()).toContain('VOICE_ENABLED=false');
  });

  it('refuses to change anything when the voice channel is not installed', async () => {
    env([]);
    const off = port({ installed: () => false });
    await expect(off.newToken()).rejects.toBeInstanceOf(PhoneError);
    await expect(off.setEnabled(false)).rejects.toMatchObject({ code: 'not_installed' });
    expect(readEnv()).toBe('\n');
  });
});

describe('pairing', () => {
  const pairingFile = () => path.join(root, 'data', 'voice-pairing.json');
  const ready = () => env([`VOICE_ENABLED=true`, `VOICE_AUTH_TOKEN=${TOKEN}`, 'VOICE_BIND_HOST=100.64.0.9']);

  it('makes a code from the pairing alphabet, different each time', () => {
    const code = makePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(makePairingCode()).not.toBe(code);
    expect(makePairingCode(() => Buffer.alloc(16, 0xff))).toBe('Z'.repeat(16));
  });

  it('writes the link as the protocol says, with the address encoded', () => {
    expect(pairingLink('ws://100.64.0.9:8767', '7H2KQ9M4XB5TD3WE')).toBe(
      'nanovoice://pair?v=1&server=ws%3A%2F%2F100.64.0.9%3A8767&code=7H2KQ9M4XB5TD3WE',
    );
  });

  it('leaves only the hash of the code on disk, with a five-minute life, and draws the whole link', async () => {
    ready();
    let drawn = '';
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    const started = await port({
      now: () => now,
      matrix: (text) => ((drawn = text), { size: 1, rows: ['1'] }),
    }).startPairing();
    expect(started).toEqual({
      matrix: { size: 1, rows: ['1'] },
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
    });
    const code = /code=([0-9A-Z]{16})$/.exec(drawn)![1];
    expect(drawn.startsWith('nanovoice://pair?v=1&server=ws%3A%2F%2F100.64.0.9%3A8767&code=')).toBe(true);
    const stored = fs.readFileSync(pairingFile(), 'utf8');
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(TOKEN);
    expect(JSON.parse(stored)).toEqual({
      hash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      attempts: 0,
    });
    expect(fs.statSync(pairingFile()).mode & 0o077).toBe(0);
  });

  it('replaces a waiting code with a new one, and reports it as pending until it expires or is cancelled', async () => {
    ready();
    let now = Date.parse('2026-10-02T12:00:00.000Z');
    const p = port({ now: () => now, matrix: () => ({ size: 1, rows: ['1'] }) });
    await p.startPairing();
    const first = fs.readFileSync(pairingFile(), 'utf8');
    await p.startPairing();
    expect(fs.readFileSync(pairingFile(), 'utf8')).not.toBe(first);
    expect((await p.status()).pairingPending).toBe(true);
    now += PAIRING_TTL_MS + 1;
    expect((await p.status()).pairingPending).toBe(false);
    now -= PAIRING_TTL_MS;
    expect((await p.status()).pairingPending).toBe(true);
    await p.cancelPairing();
    expect(fs.existsSync(pairingFile())).toBe(false);
    expect((await p.status()).pairingPending).toBe(false);
    await p.cancelPairing(); // nothing to cancel is not an error
  });

  it('refuses when there is no token, no usable address, or no voice channel, writing nothing', async () => {
    env([`VOICE_AUTH_TOKEN=${TOKEN}`]); // the channel listens on this machine only
    await expect(port().startPairing()).rejects.toMatchObject({ code: 'no_address' });
    env(['VOICE_BIND_HOST=100.64.0.9']);
    await expect(port().startPairing()).rejects.toMatchObject({ code: 'token_missing' });
    ready();
    await expect(port({ installed: () => false }).startPairing()).rejects.toMatchObject({ code: 'not_installed' });
    expect(fs.existsSync(pairingFile())).toBe(false);
  });

  it('draws a real QR code for the link', async () => {
    ready();
    const started = await port().startPairing();
    expect(started.matrix.size).toBeGreaterThan(20);
    expect(started.matrix.rows).toHaveLength(started.matrix.size);
    expect(started.matrix.rows.every((row) => /^[01]+$/.test(row) && row.length === started.matrix.size)).toBe(true);
  });
});
