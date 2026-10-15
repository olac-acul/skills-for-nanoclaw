import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBundle, includeInData } from './bundle.js';
import { generateKey } from './crypto.js';
import { createSyntheticInstall, type SyntheticInstall } from './fixtures/synthetic-install.js';
import { filterEnvForRehearsal, isTargetOwnedEnv, restoreBundle } from './restore.js';

/**
 * The NanoVoice voice channel keeps three files in data/ and five settings in .env. What a backup does with them:
 *  - a full restore brings back the token, the switch, the port and the phone's wake-up address, so a paired phone
 *    keeps working;
 *  - the address the channel listens on belongs to the machine it runs on, so the restoring machine keeps its own;
 *  - a rehearsal restore leaves out everything of the voice channel: it must not listen for the phone, accept its
 *    token or wake it;
 *  - the live state (who is connected, a pairing code that waits) is never part of a backup.
 */
const TOKEN = 'v'.repeat(48);
const VOICE_ENV = [
  'VOICE_ENABLED=true',
  `VOICE_AUTH_TOKEN=${TOKEN}`,
  'VOICE_BIND_HOST=100.101.102.109',
  'VOICE_CHANNEL_PORT=8767',
  'VOICE_PLATFORM_ID=default',
];
const PUSH = '{"url":"https://push.example/up1"}';

let tmp: string;
let source: SyntheticInstall;
let target: SyntheticInstall;
let key: Buffer;
let bundleFile: string;

const data = (install: SyntheticInstall, name: string) => path.join(install.project, 'data', name);
const env = (install: SyntheticInstall) => fs.readFileSync(path.join(install.project, '.env'), 'utf8');

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-voice-'));
  source = createSyntheticInstall(tmp, { label: 'source' });
  target = createSyntheticInstall(tmp, { label: 'target', groups: ['t1'] });
  fs.appendFileSync(path.join(source.project, '.env'), `${VOICE_ENV.join('\n')}\n`);
  fs.writeFileSync(data(source, 'voice-push.json'), PUSH);
  fs.writeFileSync(data(source, 'voice-status.json'), '{"listening":true,"connected":true}');
  fs.writeFileSync(data(source, 'voice-status.json.tmp'), '{}');
  fs.writeFileSync(
    data(source, 'voice-pairing.json'),
    '{"hash":"x","expiresAt":"2099-01-01T00:00:00.000Z","attempts":0}',
  );
  key = generateKey();
  bundleFile = path.join(tmp, 'bundles', 'source.mbk');
  await createBundle({ host: source.host, key, destFile: bundleFile });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('what a bundle holds of the voice channel', () => {
  it("keeps the phone's wake-up address but not the live state", () => {
    const file = (name: string) => includeInData(name, fs.statSync(data(source, name)));
    expect(file('voice-push.json')).toBe(true);
    expect(file('voice-status.json')).toBe(false);
    expect(file('voice-status.json.tmp')).toBe(false);
    expect(file('voice-pairing.json')).toBe(false);
  });

  it('only leaves out those names at the top of data/, not a file that happens to share one', () => {
    const stat = fs.statSync(data(source, 'voice-push.json'));
    expect(includeInData('sessions/voice-status.json', stat)).toBe(true);
  });
});

describe('a full restore', () => {
  it('brings back the token, the switch, the port and the wake-up address, and no live state', async () => {
    fs.writeFileSync(data(target, 'voice-status.json'), '{"listening":false}'); // the target's own, left over
    await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    const text = env(target);
    expect(text).toContain('VOICE_ENABLED=true');
    expect(text).toContain(`VOICE_AUTH_TOKEN=${TOKEN}`);
    expect(text).toContain('VOICE_CHANNEL_PORT=8767');
    expect(text).toContain('VOICE_PLATFORM_ID=default');
    expect(fs.readFileSync(data(target, 'voice-push.json'), 'utf8')).toBe(PUSH);
    expect(fs.existsSync(data(target, 'voice-status.json'))).toBe(false);
    expect(fs.existsSync(data(target, 'voice-pairing.json'))).toBe(false);
  });

  it('keeps the address this machine listens on, not the one from the backup', async () => {
    fs.appendFileSync(path.join(target.project, '.env'), 'VOICE_BIND_HOST=100.64.0.77\n');
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    const text = env(target);
    expect(text).toContain('VOICE_BIND_HOST=100.64.0.77');
    expect(text).not.toContain('VOICE_BIND_HOST=100.101.102.109');
    expect(result.keptEnvKeys).toContain('VOICE_BIND_HOST');
  });

  it('leaves the channel on the safe default address when this machine had none', async () => {
    await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    expect(env(target)).not.toContain('VOICE_BIND_HOST'); // the channel then listens on this machine only until it is set
  });
});

describe('a rehearsal restore', () => {
  it('leaves out every voice setting and the wake-up address', async () => {
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'rehearsal' });
    expect(env(target)).not.toContain('VOICE_');
    expect(env(target)).not.toContain(TOKEN);
    for (const name of ['VOICE_ENABLED', 'VOICE_AUTH_TOKEN', 'VOICE_CHANNEL_PORT', 'VOICE_PLATFORM_ID'])
      expect(result.droppedEnvKeys).toContain(name);
    expect(fs.existsSync(data(target, 'voice-push.json'))).toBe(false);
    expect(fs.existsSync(data(target, 'voice-status.json'))).toBe(false);
    expect(fs.existsSync(data(target, 'voice-pairing.json'))).toBe(false);
  });

  it('would drop the settings by name, whatever else the file holds', () => {
    const { kept, dropped } = filterEnvForRehearsal(`${VOICE_ENV.join('\n')}\nOPENCODE_MODEL=openai/test\n`);
    expect(kept.trim()).toBe('OPENCODE_MODEL=openai/test');
    expect(dropped.sort()).toEqual([
      'VOICE_AUTH_TOKEN',
      'VOICE_BIND_HOST',
      'VOICE_CHANNEL_PORT',
      'VOICE_ENABLED',
      'VOICE_PLATFORM_ID',
    ]);
  });
});

describe('machine-owned settings', () => {
  it('names the listening address, and not the token, the switch or the port', () => {
    expect(isTargetOwnedEnv('VOICE_BIND_HOST')).toBe(true);
    for (const name of ['VOICE_AUTH_TOKEN', 'VOICE_ENABLED', 'VOICE_CHANNEL_PORT'])
      expect(isTargetOwnedEnv(name)).toBe(false);
  });
});
