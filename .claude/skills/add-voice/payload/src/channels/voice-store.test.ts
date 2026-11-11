import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { FailedAttempts } from './voice-net.js';
import {
  loadActivity,
  loadPending,
  loadPushEndpoint,
  PENDING_FILES_MAX,
  readPairing,
  saveActivity,
  savePending,
  savePushEndpoint,
  writePairing,
} from './voice-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voice-store-'));

describe('voice state files', () => {
  it('are written whole with mode 0600 and read back', () => {
    const file = path.join(tmp(), 'sub', 'voice-activity.json');
    saveActivity(file, { at: 42, pauseAnnounced: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadActivity(file)).toEqual({ at: 42, pauseAnnounced: true });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['voice-activity.json']); // no temporary file left
  });

  it('read a missing or damaged file as nothing', () => {
    const file = path.join(tmp(), 'x.json');
    expect(loadActivity(file)).toEqual({ at: 0, pauseAnnounced: false });
    fs.writeFileSync(file, '{bad');
    expect(loadPending(file)).toEqual({ notify: [], files: [] });
    fs.writeFileSync(file, '[1,2]');
    expect(readPairing(file)).toBeNull();
    expect(loadActivity(null)).toEqual({ at: 0, pauseAnnounced: false });
  });

  it('keep only valid pending entries, the newest files, and no file when empty', () => {
    const file = path.join(tmp(), 'voice-pending.json');
    const files = Array.from({ length: PENDING_FILES_MAX + 2 }, (_, i) => ({ type: 'file', name: `f${i}` }));
    fs.writeFileSync(file, JSON.stringify({ notify: ['a', 3, 'b'], files: [{ type: 'other' }, ...files] }));
    const pending = loadPending(file);
    expect(pending.notify).toEqual(['a', 'b']);
    expect(pending.files.map((f) => f.name)).toEqual(files.slice(-PENDING_FILES_MAX).map((f) => f.name));
    savePending(file, { notify: [], files: [] });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keep a push endpoint only while it is valid, and remove it', () => {
    const file = path.join(tmp(), 'voice-push.json');
    savePushEndpoint(file, 'https://push.example.org/x');
    expect(loadPushEndpoint(file, 'public')).toBe('https://push.example.org/x');
    savePushEndpoint(file, 'http://192.168.1.2/x'); // privacy-scan: allow (test address)
    expect(loadPushEndpoint(file, 'public')).toBeNull();
    savePushEndpoint(file, null);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('round-trip a pairing code with its attempts', () => {
    const file = path.join(tmp(), 'voice-pairing.json');
    const pairing = { hash: 'a'.repeat(64), expiresAt: Date.parse('2030-01-01T00:00:00Z'), attempts: 2 };
    writePairing(file, pairing);
    expect(readPairing(file)).toEqual(pairing);
  });
});

describe('FailedAttempts', () => {
  it('refuses an address after ten failures and forgets it on success', () => {
    const tries = new FailedAttempts('test');
    for (let i = 0; i < 9; i++) tries.note('a');
    expect(tries.refused('a')).toBe(false);
    tries.note('a');
    expect(tries.refused('a')).toBe(true);
    expect(tries.refused('b')).toBe(false);
    tries.forget('a');
    expect(tries.refused('a')).toBe(false);
  });
});
