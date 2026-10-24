import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SKILLS } from './install-skills.mjs';
import { OUR_SKILLS } from './update-install.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installSh = fs.readFileSync(path.join(repo, 'install.sh'), 'utf8');

/** One shell function of install.sh, as written there. */
function shellFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(installSh);
  assert.ok(match, `install.sh has no ${name}()`);
  return match[0];
}

test('install.sh, the installer, the updater and the README name the same skills', () => {
  assert.equal(OUR_SKILLS, DEFAULT_SKILLS);
  const step = shellFunction('step_skills');
  const named = new Set([...step.matchAll(/add-[a-z-]+/g)].map((match) => match[0]));
  assert.deepEqual([...named].sort(), [...DEFAULT_SKILLS].sort());
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  for (const skill of DEFAULT_SKILLS) assert.match(readme, new RegExp(`\\| \\[\`${skill}\`\\]`), `README.md has no row for ${skill}`);
});

test("install.sh's set_env replaces or appends one key, keeps the other lines and leaves .env private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-env-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), '# comment\nKEEP=1\nPANEL_BIND=127.0.0.1\nPANEL_BINDING=x\n', { mode: 0o644 });
    const script = `in_install() { (cd "$INSTALL_DIR" && bash -c "$1"); }\n${shellFunction('set_env')}\nset_env PANEL_BIND 0.0.0.0\nset_env OPENCODE_MODEL_CONTEXT_LIMIT 65536\n`;
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, INSTALL_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(path.join(dir, '.env'), 'utf8'),
      '# comment\nKEEP=1\nPANEL_BINDING=x\nPANEL_BIND=0.0.0.0\nOPENCODE_MODEL_CONTEXT_LIMIT=65536\n',
    );
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['.env']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set_env makes a missing .env private from the start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-env-'));
  try {
    const script = `in_install() { (cd "$INSTALL_DIR" && bash -c "$1"); }\n${shellFunction('set_env')}\nset_env PANEL_BIND 127.0.0.1\n`;
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, INSTALL_DIR: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'PANEL_BIND=127.0.0.1\n');
    assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
