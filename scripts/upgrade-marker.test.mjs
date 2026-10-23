import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { commitAll, markerMatches, treeIsClean } from './upgrade-marker.mjs';

const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** A tiny install: package.json committed, and a marker written the way upstream writes it. */
function install() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2026.10.0' }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'upstream');
  return dir;
}
const stamp = (dir) => {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const marker = { version: '2026.10.0', commit: git(dir, 'rev-parse', 'HEAD'), tree: git(dir, 'rev-parse', 'HEAD^{tree}') };
  fs.writeFileSync(path.join(dir, 'data', 'upgrade-state.json'), JSON.stringify(marker));
};

test('the marker matches HEAD as upstream checks it, and uncommitted changes do not matter', () => {
  const dir = install();
  try {
    assert.equal(markerMatches(dir), false); // no marker yet
    stamp(dir);
    assert.equal(markerMatches(dir), true);
    fs.writeFileSync(path.join(dir, 'skill.ts'), 'export {};\n');
    assert.equal(markerMatches(dir), true); // still the same HEAD
    assert.equal(treeIsClean(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a commit after the marker is what trips it (the bug of a stamp written before the commit)', () => {
  const dir = install();
  try {
    stamp(dir);
    fs.writeFileSync(path.join(dir, 'skill.ts'), 'export {};\n');
    assert.equal(commitAll(dir, 'local: skills'), null);
    assert.equal(treeIsClean(dir), true);
    assert.equal(markerMatches(dir), false);
    stamp(dir); // what install-skills and update-install now do after their commit
    assert.equal(markerMatches(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a version change in package.json is a mismatch too', () => {
  const dir = install();
  try {
    stamp(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2026.11.0' }));
    assert.equal(markerMatches(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commits without a Git identity of its own', () => {
  const dir = install();
  try {
    git(dir, 'config', '--unset', 'user.email');
    git(dir, 'config', '--unset', 'user.name');
    fs.writeFileSync(path.join(dir, 'skill.ts'), 'export {};\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      assert.equal(commitAll(dir, 'local: skills'), null);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    assert.match(git(dir, 'log', '-1', '--format=%ae'), /skills-installer@localhost/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with nothing to commit there is no commit and no error', () => {
  const dir = install();
  try {
    const before = git(dir, 'rev-parse', 'HEAD');
    assert.equal(commitAll(dir, 'local: skills'), null);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
