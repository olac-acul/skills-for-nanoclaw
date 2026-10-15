import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { PANEL_IMPORT, PORTAL_IMPORT, withPanelImport } from '../.claude/skills/add-manager-panel/payload/scripts/panel-barrel.mjs';

const script = resolve('.claude/skills/add-manager-panel/payload/scripts/panel-barrel.mjs');
const barrel = (...imports) => `// modules\n${imports.join('\n')}\n`;

test('goes before the community-portal import when there is one', () => {
  const out = withPanelImport(barrel("import './self-mod/index.js';", PORTAL_IMPORT));
  assert.equal(out, barrel("import './self-mod/index.js';", PANEL_IMPORT, PORTAL_IMPORT));
});

test('goes at the end when there is no portal import', () => {
  assert.equal(withPanelImport(barrel("import './self-mod/index.js';")), barrel("import './self-mod/index.js';", PANEL_IMPORT));
});

test('running it again changes nothing', () => {
  const once = withPanelImport(barrel("import './a.js';", PORTAL_IMPORT));
  assert.equal(withPanelImport(once), once);
  const bare = withPanelImport(barrel("import './a.js';"));
  assert.equal(withPanelImport(bare), bare);
});

test('moves a line an earlier install left after the portal, and never doubles it', () => {
  const moved = withPanelImport(barrel(PORTAL_IMPORT, PANEL_IMPORT));
  assert.equal(moved, barrel(PANEL_IMPORT, PORTAL_IMPORT));
  assert.equal(moved.split(PANEL_IMPORT).length - 1, 1);
});

test('keeps the rest of the file as it was, a trailing blank line included', () => {
  const text = `// header\n\n/* note */\nimport './a.js';\n\nimport './b.js';\n${PORTAL_IMPORT}\n\n`;
  const out = withPanelImport(text);
  assert.equal(out, `// header\n\n/* note */\nimport './a.js';\n\nimport './b.js';\n${PANEL_IMPORT}\n${PORTAL_IMPORT}\n\n`);
});

test('the command line: --check says whether it is in place, a bare run places it, a missing file exits 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'barrel-'));
  try {
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run().status, 2);
    mkdirSync(join(root, 'src', 'modules'), { recursive: true });
    const file = join(root, 'src', 'modules', 'index.ts');
    writeFileSync(file, barrel("import './a.js';", PORTAL_IMPORT));
    assert.equal(run('--check').status, 1);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    assert.equal(readFileSync(file, 'utf8'), barrel("import './a.js';", PANEL_IMPORT, PORTAL_IMPORT));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
