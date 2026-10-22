import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { SEAMS, apply, plan } from '../.claude/skills/add-voice/payload/scripts/voice-core-seams.mjs';

const script = resolve('.claude/skills/add-voice/payload/scripts/voice-core-seams.mjs');

/** A stand-in for each core file: the anchors of its edits among unrelated lines. */
function install() {
  const root = mkdtempSync(join(tmpdir(), 'seams-'));
  for (const { file, edits } of SEAMS) {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, ['// unrelated start', ...edits.map((e) => e.anchor), '// unrelated end', ''].join('\n'));
  }
  return root;
}
const read = (root, file) => readFileSync(join(root, file), 'utf8');
const snapshot = (root) => SEAMS.map(({ file }) => read(root, file));

test('applies every edit, and every marker is present afterwards', () => {
  const root = install();
  try {
    const written = apply(root);
    assert.equal(written.length, SEAMS.length);
    for (const { file, edits } of SEAMS) for (const edit of edits) assert.ok(read(root, file).includes(edit.marker), `${file}: ${edit.name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('running it again changes nothing', () => {
  const root = install();
  try {
    apply(root);
    const before = snapshot(root);
    assert.deepEqual(apply(root), []);
    assert.deepEqual(snapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finishes a partly applied install without doubling an edit', () => {
  const root = install();
  try {
    const first = SEAMS[0];
    const full = join(root, first.file);
    writeFileSync(full, readFileSync(full, 'utf8').replace(first.edits[0].anchor, first.edits[0].replace));
    apply(root);
    for (const { file, edits } of SEAMS) for (const edit of edits) assert.equal(read(root, file).split(edit.marker).length - 1, 1, `${file}: ${edit.name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes nothing at all when one anchor has moved, even in files that would have worked', () => {
  const root = install();
  try {
    const last = SEAMS[SEAMS.length - 1];
    const full = join(root, last.file);
    writeFileSync(full, readFileSync(full, 'utf8').replace(last.edits[0].anchor, '// upstream rewrote this\n'));
    const before = snapshot(root);
    assert.throws(() => apply(root), (error) => error.problems.length === 1 && error.problems[0].includes(last.file));
    assert.deepEqual(snapshot(root), before);
    assert.ok(!existsSync(`${full}.seams-tmp`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses an anchor that now occurs twice', () => {
  const root = install();
  try {
    const first = SEAMS[0];
    const full = join(root, first.file);
    writeFileSync(full, `${readFileSync(full, 'utf8')}${first.edits[0].anchor}`);
    const { problems } = plan(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /occurs 2 time/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports a missing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'seams-'));
  try {
    assert.ok(plan(root).problems.every((p) => p.includes('file not found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the command line: --check fails before, passes after; a broken tree exits 2 with a clear message', () => {
  const root = install();
  try {
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run('--check').status, 1);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    const bad = install();
    try {
      const full = join(bad, SEAMS[1].file);
      writeFileSync(full, 'nothing here\n');
      const result = spawnSync(process.execPath, [script], { cwd: bad, encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /NOTHING WAS CHANGED/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an optional file that is absent is skipped, not a problem', () => {
  const root = install();
  try {
    const optional = SEAMS.filter((s) => s.optional);
    assert.ok(optional.length > 0, 'there is an optional seam');
    for (const { file } of optional) rmSync(join(root, file));
    const { problems } = plan(root);
    assert.deepEqual(problems, []);
    assert.equal(apply(root).length, SEAMS.length - optional.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

