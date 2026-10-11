import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseKey } from './crypto.js';
import {
  DEFAULT_SCHEDULE,
  ScheduleError,
  initScheduledKey,
  readScheduledKey,
  renderUnits,
  scheduledKeyPath,
  validateSchedule,
} from './schedule.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-schedule-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the scheduled-backup key', () => {
  it('is created once, private, and read back as the same key', () => {
    const file = scheduledKeyPath(tmp);
    const shown = initScheduledKey(file);
    expect(shown).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
    expect(readScheduledKey(file).equals(parseKey(shown))).toBe(true);
  });

  it('is never replaced by a second init', () => {
    const file = scheduledKeyPath(tmp);
    const first = initScheduledKey(file);
    expect(() => initScheduledKey(file)).toThrowError(ScheduleError);
    expect(readScheduledKey(file).equals(parseKey(first))).toBe(true);
  });

  it('is refused when missing, loose, a link, or not a key', () => {
    const file = scheduledKeyPath(tmp);
    expect(() => readScheduledKey(file)).toThrowError(/init-key/);
    initScheduledKey(file);
    fs.chmodSync(file, 0o640);
    expect(() => readScheduledKey(file)).toThrowError(/mode 0600/);
    fs.chmodSync(file, 0o600);
    const link = path.join(tmp, 'link.key');
    fs.symlinkSync(file, link);
    expect(() => readScheduledKey(link)).toThrowError(ScheduleError);
    fs.writeFileSync(file, 'not a key\n', { mode: 0o600 });
    expect(() => readScheduledKey(file)).toThrowError(/valid backup key/);
  });
});

describe('validateSchedule', () => {
  it('defaults to weekly on Sunday at 03:30, keeping three', () => {
    expect(validateSchedule({})).toEqual(DEFAULT_SCHEDULE);
    expect(DEFAULT_SCHEDULE).toEqual({ keep: 3, weekday: 'Sun', time: '03:30' });
  });

  it('accepts sensible values, including numbers as text from the command line', () => {
    expect(validateSchedule({ keep: '5', weekday: 'Fri', time: '23:05' })).toEqual({
      keep: 5,
      weekday: 'Fri',
      time: '23:05',
    });
  });

  it.each([
    [{ keep: 0 }],
    [{ keep: 53 }],
    [{ keep: 1.5 }],
    [{ keep: 'many' }],
    [{ weekday: 'Sunday' }],
    [{ weekday: 'Sun *-*-* 00:00:00\nExecStart=evil' }],
    [{ time: '24:00' }],
    [{ time: '3:30' }],
    [{ time: '03:30:00' }],
    [{ time: true }],
  ])('refuses %j', (input) => {
    expect(() => validateSchedule(input)).toThrowError(ScheduleError);
  });
});

describe('renderUnits', () => {
  const input = {
    name: 'nanoclaw-backup-abc123',
    projectRoot: '/home/user/nanoclaw',
    nodeBin: '/usr/local/bin/node',
    tsxCli: '/home/user/nanoclaw/node_modules/tsx/dist/cli.mjs',
    settings: { keep: 3, weekday: 'Sun' as const, time: '03:30' },
  };

  it('builds a oneshot service that runs the scheduled command and a persistent weekly timer', () => {
    const { service, timer } = renderUnits(input);
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('WorkingDirectory="/home/user/nanoclaw"');
    expect(service).toContain(
      'ExecStart="/usr/local/bin/node" "/home/user/nanoclaw/node_modules/tsx/dist/cli.mjs" scripts/manager-backup.ts scheduled --keep 3',
    );
    expect(service).toContain('NoNewPrivileges=true');
    expect(timer).toContain('OnCalendar=Sun *-*-* 03:30:00');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=nanoclaw-backup-abc123.service');
    expect(timer).toContain('WantedBy=timers.target');
  });

  it('quotes paths so a space or a percent sign cannot change the command', () => {
    const { service } = renderUnits({ ...input, projectRoot: '/home/user/my install%h' });
    expect(service).toContain('WorkingDirectory="/home/user/my install%%h"');
  });

  it('refuses a path with a line break', () => {
    expect(() => renderUnits({ ...input, projectRoot: '/home/user/x\nExecStart=/bin/evil' })).toThrowError(
      ScheduleError,
    );
  });
});
