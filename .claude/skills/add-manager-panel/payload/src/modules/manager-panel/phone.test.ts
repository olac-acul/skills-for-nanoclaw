import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PhoneError, addressFor, createPhonePort, readRecordedStatus, type PhoneOptions } from './phone.js';

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
      locale: 'it-IT',
    });
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
