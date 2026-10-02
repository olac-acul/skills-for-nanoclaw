import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EnvFileError, readEnvKeys, updateEnvKeys } from './env-file.js';

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
