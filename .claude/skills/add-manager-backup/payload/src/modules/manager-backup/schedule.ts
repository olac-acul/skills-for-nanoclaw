/**
 * Scheduled backups: the key they use, and the systemd units that run them.
 *
 * A manual backup has a random key shown once to whoever made it. A backup nobody is watching cannot ask
 * for one, so scheduled backups use a key of their own: made once with `schedule init-key`, shown once, and
 * kept in a private file (mode 0600) outside the backups folder. Anyone who holds the key and a bundle can
 * open it, so a copy of the key belongs in a password manager, and bundles that leave this machine should
 * leave without the key.
 *
 * Nothing here talks to NanoClaw or to systemd: it builds text and checks files, so it can be tested.
 */
import fs from 'node:fs';
import path from 'node:path';

import { formatKey, generateKey, parseKey } from './crypto.js';

export class ScheduleError extends Error {
  constructor(
    readonly code: 'key_missing' | 'key_exists' | 'key_unsafe' | 'key_invalid' | 'invalid_setting',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** Where the scheduled backups' key lives. */
export function scheduledKeyPath(home: string): string {
  return path.join(home, '.config', 'nanoclaw', 'scheduled-backup.key');
}

/** Create the key file (refusing to replace one) and return the key to show to the owner, once. */
export function initScheduledKey(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = formatKey(generateKey());
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ScheduleError('key_exists', `a scheduled-backup key already exists at ${file}; it was not replaced`);
    throw error;
  }
  try {
    fs.writeSync(fd, `${text}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return text;
}

/** Read the key, refusing a file other users could read. */
export function readScheduledKey(file: string): Buffer {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ScheduleError('key_missing', `no scheduled-backup key at ${file}; run: schedule init-key`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
    throw new ScheduleError('key_unsafe', `${file} must be a regular file readable by its owner only (mode 0600)`);
  try {
    return parseKey(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ScheduleError('key_invalid', `${file} does not hold a valid backup key`);
  }
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface ScheduleSettings {
  /** Scheduled backups to keep; older scheduled ones are deleted, manual ones never. */
  keep: number;
  weekday: Weekday;
  /** `HH:MM`, local time of the machine. */
  time: string;
}

export const DEFAULT_SCHEDULE: ScheduleSettings = { keep: 3, weekday: 'Sun', time: '03:30' };

/** Check settings that end up in a systemd unit; anything else is refused. */
export function validateSchedule(input: { keep?: unknown; weekday?: unknown; time?: unknown }): ScheduleSettings {
  const keep = input.keep === undefined ? DEFAULT_SCHEDULE.keep : Number(input.keep);
  if (!Number.isInteger(keep) || keep < 1 || keep > 52)
    throw new ScheduleError('invalid_setting', 'keep must be a whole number from 1 to 52');
  const weekday = (input.weekday === undefined ? DEFAULT_SCHEDULE.weekday : input.weekday) as Weekday;
  if (!WEEKDAYS.includes(weekday))
    throw new ScheduleError('invalid_setting', `weekday must be one of ${WEEKDAYS.join(', ')}`);
  const time = input.time === undefined ? DEFAULT_SCHEDULE.time : input.time;
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new ScheduleError('invalid_setting', 'time must be HH:MM, 24 hours');
  return { keep, weekday, time };
}

export interface UnitInput {
  /** Name shared by the two units, without the suffix. */
  name: string;
  projectRoot: string;
  nodeBin: string;
  /** The tsx entry point, as an absolute path. */
  tsxCli: string;
  settings: ScheduleSettings;
}

function quote(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new ScheduleError('invalid_setting', 'a path contains a control character');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** The oneshot service and the weekly timer. A run that was missed (machine off) happens at the next start. */
export function renderUnits(input: UnitInput): { service: string; timer: string } {
  const { settings } = input;
  const service = `[Unit]
Description=NanoClaw scheduled backup (keeps the last ${settings.keep})
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${quote(input.projectRoot)}
ExecStart=${quote(input.nodeBin)} ${quote(input.tsxCli)} scripts/manager-backup.ts scheduled --keep ${settings.keep}
TimeoutStartSec=4h
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
`;
  const timer = `[Unit]
Description=NanoClaw scheduled backup, weekly

[Timer]
OnCalendar=${settings.weekday} *-*-* ${settings.time}:00
Persistent=true
RandomizedDelaySec=10min
Unit=${input.name}.service

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}
