import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canRestoreValue, EnvFileError, readEnvKeys, updateEnvKeys } from './env-file.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-env-'));
  file = path.join(dir, '.env');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('updateEnvKeys', () => {
  it('replaces in place, appends new keys, removes others, and keeps everything else', () => {
    fs.writeFileSync(file, '# settings\nA=1\nexport B="two"\n\nC=3\nA=duplicate\n', { mode: 0o640 });
    const before = updateEnvKeys(file, { A: 'x', B: null, D: 'new' });
    expect(before).toEqual({ A: 'duplicate', B: 'two', D: null });
    expect(fs.readFileSync(file, 'utf8')).toBe('# settings\nA=x\n\nC=3\nD=new\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('creates a private file when none exists', () => {
    updateEnvKeys(file, { A: 'b' });
    expect(fs.readFileSync(file, 'utf8')).toBe('A=b\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('restores exactly from the returned previous values', () => {
    fs.writeFileSync(file, 'A=1\nB=2\n');
    const before = updateEnvKeys(file, { A: 'changed', B: null, C: 'added' });
    updateEnvKeys(file, before);
    expect(readEnvKeys(file, ['A', 'B', 'C'])).toEqual({ A: '1', B: '2', C: null });
  });

  it.each(['a b', 'a\nB=1', "a'b", 'a"b', 'a$b', 'a`b`', 'a;b', 'x'.repeat(3000)])(
    'rejects unsafe value %j',
    (value) => {
      expect(() => updateEnvKeys(file, { A: value })).toThrow(EnvFileError);
      expect(fs.existsSync(file)).toBe(false);
    },
  );

  it('accepts an IPv6 literal URL', () => {
    updateEnvKeys(file, { A: 'http://[fd00::1]:8000/v1' });
    expect(readEnvKeys(file, ['A']).A).toBe('http://[fd00::1]:8000/v1');
  });

  it('restores hand-written values that fail the strict check for new ones', () => {
    fs.writeFileSync(file, 'A=~/models\nB="two words"\nC=x # note\nD=\'it works\'\nE=plain\n');
    const before = readEnvKeys(file, ['A', 'B', 'C', 'D', 'E']);
    expect(before).toEqual({ A: '~/models', B: 'two words', C: 'x', D: 'it works', E: 'plain' });
    updateEnvKeys(file, { A: 'new', B: 'new', C: 'new', D: 'new', E: null });
    expect(() => updateEnvKeys(file, before)).toThrow(EnvFileError);
    updateEnvKeys(file, before, { restore: true });
    expect(readEnvKeys(file, ['A', 'B', 'C', 'D', 'E'])).toEqual(before);
  });

  it('still refuses to restore a value that cannot be kept to one line', () => {
    expect(() => updateEnvKeys(file, { A: 'a\nB=1' }, { restore: true })).toThrow(EnvFileError);
    expect(canRestoreValue('it\'s "both"')).toBe(false);
    expect(canRestoreValue('two words')).toBe(true);
  });

  it('uses an exclusive temporary file and leaves none behind, even when the write fails', () => {
    fs.writeFileSync(file, 'SECRET=1\n', { mode: 0o600 });
    // A file or symlink planted at the old predictable name is not touched.
    const victim = path.join(dir, 'victim');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
    updateEnvKeys(file, { A: 'b' });
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    fs.unlinkSync(`${file}.${process.pid}.tmp`);
    // Failure after the temp file exists: rename onto a directory.
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    expect(() => updateEnvKeys(target, { A: 'b' })).toThrow();
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects invalid keys', () => {
    expect(() => updateEnvKeys(file, { 'a=b': '1' })).toThrow(EnvFileError);
    expect(() => updateEnvKeys(file, { lower: '1' })).toThrow(EnvFileError);
  });
});

describe('readEnvKeys', () => {
  it('reads quoted and exported assignments and ignores the rest', () => {
    fs.writeFileSync(file, "export A='one'\nB = two\n#C=3\nD=\n");
    expect(readEnvKeys(file, ['A', 'B', 'C', 'D', 'E'])).toEqual({ A: 'one', B: 'two', C: null, D: '', E: null });
  });
  it('treats a missing file as empty', () => {
    expect(readEnvKeys(file, ['A'])).toEqual({ A: null });
  });
});
