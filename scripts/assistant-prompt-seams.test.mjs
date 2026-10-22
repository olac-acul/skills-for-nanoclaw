import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { SEAMS as VOICE_SEAMS, apply as applyVoice } from '../.claude/skills/add-voice/payload/scripts/voice-core-seams.mjs';
import { SEAMS, apply, plan } from '../.claude/skills/add-assistant-prompt/payload/scripts/assistant-prompt-seams.mjs';

const script = resolve('.claude/skills/add-assistant-prompt/payload/scripts/assistant-prompt-seams.mjs');
const FILE = 'container/agent-runner/src/providers/opencode-config.ts';

/** The lines of upstream's opencode-config.ts these edits (and the voice skill's) attach to. */
const OPENCODE_CONFIG = `import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { openCodeInstructionsPath } from './opencode-memory.js';
import { OPENCODE_CREDENTIAL_PLACEHOLDER } from './opencode-auth.js';

export function buildOpenCodeServerEnv(config, environment = process.env) {
  return {
    ...environment,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}

export function buildOpenCodeConfig(options, configuration) {
  return {
    ...inference,
    permission: configuration ? configuration.executionPolicy : resolveOpenCodeExecutionPolicy(),
    mcp: configuration ? configuration.mcpServers : mcpServersToOpenCodeConfig(options.mcpServers),
    autoupdate: false,
    snapshot: false,
    instructions: [\`\${AGENT_DIR}/CLAUDE.md\`, \`\${AGENT_DIR}/CLAUDE.local.md\`, openCodeInstructionsPath()],
  };
}
`;

function install(content = OPENCODE_CONFIG) {
  const root = mkdtempSync(join(tmpdir(), 'prompt-seams-'));
  mkdirSync(dirname(join(root, FILE)), { recursive: true });
  writeFileSync(join(root, FILE), content);
  return root;
}
const read = (root) => readFileSync(join(root, FILE), 'utf8');

test('applies every edit once, and again changes nothing', () => {
  const root = install();
  try {
    assert.deepEqual(apply(root), [FILE]);
    const once = read(root);
    for (const edit of SEAMS[0].edits) assert.equal(once.split(edit.marker).length - 1, 1, edit.name);
    assert.match(once, /\n {4}OPENCODE_CONFIG_CONTENT: JSON\.stringify\(asAssistant\(config\)\),\n/);
    assert.match(once, /permission: configuration \? configuration\.executionPolicy : resolveOpenCodeExecutionPolicy\(\),/);
    assert.deepEqual(apply(root), []);
    assert.equal(read(root), once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("works together with the voice skill's edits of the same file, in either order", () => {
  const voiceOnly = VOICE_SEAMS.filter((s) => s.file === FILE);
  const both = [() => apply(root), () => applyVoice(root, voiceOnly)];
  let root;
  for (const steps of [both, [...both].reverse()]) {
    root = install();
    try {
      for (const step of steps) step();
      const text = read(root);
      for (const edit of [...SEAMS[0].edits, ...voiceOnly[0].edits]) assert.equal(text.split(edit.marker).length - 1, 1, edit.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('without the OpenCode provider there is nothing to do', () => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-seams-'));
  try {
    assert.deepEqual(plan(root).problems, []);
    assert.deepEqual(apply(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a moved anchor writes nothing and exits 2', () => {
  const root = install(OPENCODE_CONFIG.replace('JSON.stringify(config)', 'serialize(config)'));
  try {
    const before = read(root);
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /NOTHING WAS CHANGED/);
    assert.match(result.stderr, /the server's configuration as an assistant/);
    assert.equal(read(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the command line: --check fails before, passes after', () => {
  const root = install();
  try {
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run('--check').status, 1);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
