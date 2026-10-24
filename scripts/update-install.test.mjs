import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Install, REGENERABLE_LOCKS, describePhase, installedSkills, gatewayUpgradeScript, lockOnlyConflict, onecliTarget, parseControllerJson, planRequirements, validPin } from './update-install.mjs';

const ONECLI = {
  id: 'breaking-change-x',
  type: 'breaking-change',
  status: 'pending',
  description:
    '- [BREAKING] **OneCLI installs: upgrade the OneCLI gateway to exactly 1.42.0, which closes a credential-injection bypass.** `/update-nanoclaw` never upgrades a running gateway.',
};
const OTHER = { id: 'breaking-change-y', type: 'breaking-change', status: 'pending', description: '- [BREAKING] **Rename the widget table.** Run the migration guide.' };

test('reads the gateway version a requirement asks for, and nothing else', () => {
  assert.equal(onecliTarget(ONECLI), '1.42.0');
  assert.equal(onecliTarget(OTHER), null);
  assert.equal(onecliTarget({ description: 'Upgrade OneCLI to something newer' }), null);
  assert.equal(onecliTarget({ description: 'the gateway of OneCLI must be exactly 1.4' }), null);
  assert.equal(onecliTarget(undefined), null);
});

test('splits the requirements: the gateway upgrade is done here, anything else needs a person, done ones are skipped', () => {
  const plan = planRequirements([ONECLI, OTHER, { ...OTHER, id: 'z', status: 'succeeded' }]);
  assert.deepEqual(plan.automatic.map((r) => r.id), ['breaking-change-x']);
  assert.deepEqual(plan.manual.map((r) => r.id), ['breaking-change-y']);
  assert.deepEqual(planRequirements(undefined), { automatic: [], manual: [] });
});

test('reads the updater\'s JSON even with noise before it, and says null for nothing', () => {
  assert.deepEqual(parseControllerJson('{"phase":"prepared"}'), { phase: 'prepared' });
  assert.deepEqual(parseControllerJson('Stamped x\n{"phase":"complete"}'), { phase: 'complete' });
  assert.equal(parseControllerJson(''), null);
  assert.equal(parseControllerJson('no json here'), null);
  assert.equal(parseControllerJson('{broken'), null);
});

test('describes where a transaction stands', () => {
  assert.equal(describePhase({ phase: 'prepared', channel: 'stable', upstreamRef: 'refs/tags/v2026.10.0' }), 'phase prepared, channel stable, from v2026.10.0');
  assert.equal(describePhase({ phase: 'conflict' }), 'phase conflict');
  assert.equal(describePhase(null), 'no answer from the updater');
});

test('a gateway version is x.y.z and nothing that could carry a command', () => {
  assert.equal(validPin('1.42.0'), true);
  for (const bad of ['', '1.42', '1.42.0; rm -rf /', '$(id)', '1.42.0-rc1', undefined]) assert.equal(validPin(bad), false, String(bad));
});

test('the gateway upgrade follows upstream\'s guide: pin, compose check, dump before the pull, stops on any failure', () => {
  const script = gatewayUpgradeScript('1.42.0');
  assert.match(script, /^\s*set -e/);
  assert.match(script, /ONECLI_VERSION=1\.42\.0/);
  assert.match(script, /ghcr\.io\/onecli\/onecli:1\.42\.0/);
  assert.ok(script.indexOf('pg_dump') < script.indexOf('docker compose pull'), 'the dump comes before the pull');
  assert.ok(script.indexOf('docker compose pull') < script.indexOf('docker compose up'));
  assert.match(script, /PostgreSQL database dump complete/);
  assert.throws(() => gatewayUpgradeScript('1.42.0; id'), /not a gateway version/);
  assert.throws(() => gatewayUpgradeScript(undefined), /not a gateway version/);
});

test('a merge that conflicts only in lock files can be settled by rebuilding them, anything else is for a person', () => {
  assert.equal(lockOnlyConflict(['pnpm-lock.yaml']), true);
  assert.equal(lockOnlyConflict(['pnpm-lock.yaml', 'container/agent-runner/bun.lock']), true);
  assert.equal(lockOnlyConflict(['pnpm-lock.yaml', 'src/delivery.ts']), false);
  assert.equal(lockOnlyConflict(['package.json']), false);
  assert.equal(lockOnlyConflict([]), false);
  assert.equal(lockOnlyConflict(undefined), false);
  for (const { command } of Object.values(REGENERABLE_LOCKS)) assert.ok(command.includes('--lockfile-only'));
});

test('refreshes only the skills the install has: no voice files on an install without the voice channel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-'));
  try {
    for (const skill of ['add-manager-backup', 'add-manager-panel']) {
      fs.mkdirSync(path.join(dir, '.claude', 'skills', skill), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'skills', skill, 'SKILL.md'), '---\n');
    }
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'add-voice')); // a folder without SKILL.md is not an install
    assert.deepEqual(installedSkills(dir), ['add-manager-backup', 'add-manager-panel']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each install keeps its own prepared update', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const a = new Install(path.join(home, 'a'));
    const b = new Install(path.join(home, 'b'));
    a.writePending({ id: 'tx-a', phase: 'validated' });
    assert.equal(a.readPending()?.id, 'tx-a');
    assert.equal(b.readPending(), null);
    b.writePending({ id: 'tx-b', phase: 'conflict' });
    assert.equal(a.readPending()?.id, 'tx-a');
    b.clearPending();
    assert.equal(b.readPending(), null);
    assert.equal(a.readPending()?.id, 'tx-a');
  } finally {
    process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a pending file of an earlier version is taken only by the install its copy came from', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.nanoclaw-updates'));
    fs.writeFileSync(path.join(home, '.nanoclaw-updates', 'pending.json'), JSON.stringify({ id: 'old', stageRoot: path.join(home, 'gone') }));
    assert.equal(new Install(path.join(home, 'a')).readPending(), null);
  } finally {
    process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
