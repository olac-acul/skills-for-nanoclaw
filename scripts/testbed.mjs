#!/usr/bin/env node
/**
 * Development harness: copy every skill payload into a clean upstream
 * NanoClaw checkout (the "test bed") and run upstream's own checks on it.
 *
 *   node scripts/testbed.mjs sync            copy payload files into the test bed
 *   node scripts/testbed.mjs check [paths]   sync, then tsc + eslint + prettier + vitest
 *
 * The test bed location comes from TESTBED (default ../nanoclaw-testbed/upstream).
 * The final composition test (applying the real SKILL.md directives with
 * upstream's engine) is a separate step; this harness is the fast inner loop.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testbed = resolve(process.env.TESTBED ?? join(repo, '..', 'nanoclaw-testbed', 'upstream'));
const skillsDir = join(repo, '.claude', 'skills');

function payloadRoots() {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .map((name) => join(skillsDir, name, 'payload'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
}

function sync() {
  if (!existsSync(join(testbed, 'package.json'))) {
    console.error(`test bed not found at ${testbed} (set TESTBED)`);
    process.exit(2);
  }
  for (const root of payloadRoots()) cpSync(root, testbed, { recursive: true });
  console.log(`synced ${payloadRoots().length} payload(s) into ${testbed}`);
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync('pnpm', ['exec', cmd, ...args], { cwd: testbed, stdio: 'inherit' });
  return result.status ?? 1;
}

const [command = 'check', ...rest] = process.argv.slice(2);
if (command === 'sync') {
  sync();
} else if (command === 'check') {
  sync();
  const targets = rest.length ? rest : ['src/modules/manager-backup'];
  const failures = [
    run('tsc', ['--noEmit']),
    run('eslint', targets),
    run('prettier', ['--check', ...targets]),
    run('vitest', ['run', ...targets]),
  ].filter((status) => status !== 0);
  process.exit(failures.length ? 1 : 0);
} else {
  console.error('usage: testbed.mjs sync | check [paths...]');
  process.exit(2);
}
