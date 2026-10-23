import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SKILLS, foldersWithVoiceSection, parseArgs } from './install-skills.mjs';
import { APPLY_RUNNER } from './skill-runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('applies the skills in the order the panel needs, whatever order they are named in', () => {
  assert.deepEqual(parseArgs(['--install', '/x']).skills, DEFAULT_SKILLS);
  assert.deepEqual(parseArgs(['--install', '/x', '--skills', 'add-assistant-prompt,add-voice,add-manager-panel,add-manager-backup']).skills, DEFAULT_SKILLS);
  assert.deepEqual(parseArgs(['--install', '/x', '--skills', 'add-manager-backup']).skills, ['add-manager-backup']);
  assert.equal(parseArgs(['--install', '/x', '--no-restart']).restart, false);
  assert.equal(parseArgs(['--install', '/x']).commit, true);
  assert.equal(parseArgs(['--install', '/x', '--no-commit']).commit, false);
});

test('refuses what it cannot do', () => {
  assert.throws(() => parseArgs([]), /--install/);
  assert.throws(() => parseArgs(['--install', '/x', '--skills', 'add-telegram']), /not a skill of this repository/);
  assert.throws(() => parseArgs(['--install', '/x', '--skills', 'add-manager-panel']), /needs add-manager-backup/);
  assert.throws(() => parseArgs(['--install', '/x', '--frobnicate']), /unknown argument/);
});

test('every skill it knows exists in this repository', () => {
  for (const name of DEFAULT_SKILLS) assert.ok(fs.existsSync(path.join(here, '..', '.claude', 'skills', name, 'SKILL.md')), name);
});

test('the runner uses the engine of the install and fails on work it cannot do alone', () => {
  assert.match(APPLY_RUNNER, /from '\.\/skill-apply\.js'/);
  assert.match(APPLY_RUNNER, /process\.argv\[3\] === 'refresh' \? 'refresh' : 'install'/);
  assert.match(APPLY_RUNNER, /^\s+mode,$/m);
  assert.match(APPLY_RUNNER, /process\.exit\(3\)/);
});

test('stops before touching a folder that is not a NanoClaw install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
  try {
    const result = spawnSync(process.execPath, [path.join(here, 'install-skills.mjs'), '--install', dir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a NanoClaw install/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install.sh knows every step it runs and is valid bash', () => {
  const script = fs.readFileSync(path.join(here, '..', 'install.sh'), 'utf8');
  const loop = /for step in ([a-z ]+); do/.exec(script);
  assert.ok(loop, 'the step loop');
  for (const step of loop[1].trim().split(/\s+/)) assert.match(script, new RegExp(`^step_${step}\\(\\) \\{`, 'm'), step);
  assert.equal(spawnSync('bash', ['-n', path.join(here, '..', 'install.sh')]).status, 0);
});

test('finds the groups whose instructions carry the voice section, and only those', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-skills-'));
  try {
    const write = (folder, text) => {
      fs.mkdirSync(path.join(dir, 'groups', folder), { recursive: true });
      if (text !== null) fs.writeFileSync(path.join(dir, 'groups', folder, 'instructions.prepend.md'), text);
    };
    write('main', 'Persona.\n\n<!-- nanovoice:begin (managed by the add-voice skill) -->\nVoice.\n<!-- nanovoice:end -->\n');
    write('other', 'Persona only.\n');
    write('empty', null);
    assert.deepEqual(foldersWithVoiceSection(dir), ['main']);
    assert.deepEqual(foldersWithVoiceSection(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
