import { describe, expect, it } from 'vitest';

import { UsageError, looseKeyMode, parseArgs, printable, wholeNumber } from './cli-args.js';

describe('parseArgs', () => {
  it('accepts the documented invocations', () => {
    expect(parseArgs(['restore', 'x', '--rehearsal', '--machine-identity', '--yes']).flags.has('rehearsal')).toBe(true);
    expect(parseArgs(['schedule', 'install', '--keep', '5', '--weekday', 'Mon', '--time', '04:00']).flags).toEqual(
      new Map([
        ['keep', '5'],
        ['weekday', 'Mon'],
        ['time', '04:00'],
      ]),
    );
    expect(parseArgs(['prune', '--keep-last', '4', '--keep-monthly', '0']).flags.get('keep-last')).toBe('4');
    expect(parseArgs(['scheduled', '--keep', '2']).positional).toEqual(['scheduled']);
    expect(parseArgs(['verify', 'x', '--key-file', '/k']).flags.get('key-file')).toBe('/k');
    expect(parseArgs(['list', '--dir', '/b']).flags.get('dir')).toBe('/b');
  });

  it('accepts --name=value', () => {
    const { flags } = parseArgs(['prune', '--keep-last=3', '--dir=/b c']);
    expect(flags.get('keep-last')).toBe('3');
    expect(flags.get('dir')).toBe('/b c');
  });

  it('refuses unknown options, so a typo cannot turn a rehearsal into a full restore', () => {
    expect(() => parseArgs(['restore', 'x', '--rehersal', '--yes'])).toThrow(UsageError);
    expect(() => parseArgs(['list', '--keep-last', '1'])).toThrow(/unknown option/);
    expect(() => parseArgs(['bogus', '--yes'])).toThrow(UsageError);
    expect(() => parseArgs(['restore', 'x', '--__proto__'])).toThrow(UsageError);
  });

  it('refuses a value on a switch and a missing value on an option', () => {
    expect(() => parseArgs(['restore', 'x', '--rehearsal=1'])).toThrow(/does not take a value/);
    expect(() => parseArgs(['prune', '--keep-last'])).toThrow(/needs a value/);
    expect(() => parseArgs(['prune', '--keep-last', '--keep-monthly', '2'])).toThrow(/needs a value/);
    expect(() => parseArgs(['prune', '--keep-last='])).toThrow(/needs a value/);
  });
});

describe('wholeNumber', () => {
  it('returns the fallback when absent and validates otherwise', () => {
    expect(wholeNumber('keep-last', undefined, 1, 7)).toBe(7);
    expect(wholeNumber('keep-last', '3', 1, 7)).toBe(3);
    expect(wholeNumber('keep-monthly', '0', 0, 6)).toBe(0);
    for (const bad of ['abc', '0', '-1', '1.5', '', '1e3', ' 2'])
      expect(() => wholeNumber('keep-last', bad, 1, 7)).toThrow(UsageError);
    expect(() => wholeNumber('keep-last', true, 1, 7)).toThrow(UsageError);
  });
});

describe('printable', () => {
  it('removes terminal control sequences but keeps tabs and text', () => {
    expect(printable('a\u001b[31mred\u001b]0;title\u0007\u009b2Jb\u007f\r\nc\td')).toBe('a[31mred]0;title2Jbc\td');
    expect(printable(42)).toBe('42');
  });
});

describe('looseKeyMode', () => {
  it('flags group or other read access only', () => {
    expect(looseKeyMode(0o100600)).toBe(false);
    expect(looseKeyMode(0o100640)).toBe(true);
    expect(looseKeyMode(0o100604)).toBe(true);
  });
});
