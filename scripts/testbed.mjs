#!/usr/bin/env node
/**
 * Development harness: copy every skill payload into a clean upstream
 * NanoClaw checkout (the "test bed") and run upstream's own checks on it.
 *
 *   node scripts/testbed.mjs sync            copy payload files into the test bed
 *   node scripts/testbed.mjs check [paths]   sync, then tsc + eslint + prettier + vitest
 *   node scripts/testbed.mjs fix [paths]     sync, run prettier --write, copy formatted files back
 *
 * The test bed location comes from TESTBED (default ../nanoclaw-testbed/upstream).
 * The final composition test (applying the real SKILL.md directives with
 * upstream's engine) is a separate step; this harness is the fast inner loop.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
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

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Copy the (re-formatted) test bed versions of every payload file back into the repo. */
function pull() {
  let count = 0;
  for (const root of payloadRoots()) {
    for (const file of walk(root)) {
      const counterpart = join(testbed, relative(root, file));
      if (existsSync(counterpart)) {
        cpSync(counterpart, file);
        count++;
      }
    }
  }
  console.log(`pulled ${count} file(s) back from the test bed`);
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync('pnpm', ['exec', cmd, ...args], { cwd: testbed, stdio: 'inherit' });
  return result.status ?? 1;
}

const [command = 'check', ...rest] = process.argv.slice(2);
if (command === 'sync') {
  sync();
} else if (command === 'fix') {
  sync();
  run('prettier', ['--write', ...(rest.length ? rest : ['src/modules/manager-backup'])]);
  pull();
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
  console.error('usage: testbed.mjs sync | fix [paths...] | check [paths...]');
  process.exit(2);
}
