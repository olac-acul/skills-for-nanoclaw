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
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testbed = resolve(process.env.TESTBED ?? join(repo, '..', 'nanoclaw-testbed', 'upstream'));
const skillsDir = join(repo, '.claude', 'skills');
const DEFAULT_TARGETS = ['src/modules/manager-backup', 'src/modules/manager-panel'];

function payloadRoots() {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .map((name) => join(skillsDir, name, 'payload'))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
}

/** Apply the `nc:append` lines of every SKILL.md so the test bed is wired like a real install. */
function wire() {
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const skill = join(skillsDir, name, 'SKILL.md');
    if (!existsSync(skill)) continue;
    for (const match of readFileSync(skill, 'utf8').matchAll(/```nc:append to:(\S+)[^\n]*\n([\s\S]*?)```/g)) {
      const target = join(testbed, match[1]);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const missing = match[2].split('\n').filter((line) => line.trim() && !current.split('\n').includes(line));
      if (missing.length) writeFileSync(target, `${current.replace(/\n*$/, '\n')}${missing.join('\n')}\n`);
    }
  }
}

/** Upstream skills our code builds on (their payloads are what a real install has after applying them). */
const UPSTREAM_PAYLOADS = ['add-opencode'];

function syncUpstreamPayloads() {
  for (const name of UPSTREAM_PAYLOADS) {
    const payload = join(testbed, '.claude', 'skills', name, 'payload');
    if (existsSync(payload)) cpSync(payload, testbed, { recursive: true });
  }
}

function sync() {
  if (!existsSync(join(testbed, 'package.json'))) {
    console.error(`test bed not found at ${testbed} (set TESTBED)`);
    process.exit(2);
  }
  syncUpstreamPayloads();
  for (const root of payloadRoots()) cpSync(root, testbed, { recursive: true });
  wire();
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
  run('prettier', ['--write', ...(rest.length ? rest : [...DEFAULT_TARGETS, 'scripts/manager-backup.ts', 'scripts/manager-panel.ts'])]);
  pull();
} else if (command === 'check') {
  sync();
  const targets = rest.length ? rest : DEFAULT_TARGETS;
  const scriptConfigs = ['manager-backup', 'manager-panel', 'manager-credentials'].filter((name) => existsSync(join(testbed, 'scripts', `tsconfig.${name}.json`)));
  const scriptFiles = ['manager-backup', 'manager-panel'].map((name) => `scripts/${name}.ts`).filter((file) => existsSync(join(testbed, file)));
  const failures = [
    run('tsc', ['--noEmit']),
    ...scriptConfigs.map((name) => run('tsc', ['-p', `scripts/tsconfig.${name}.json`])),
    run('eslint', targets),
    run('prettier', ['--check', ...targets, ...scriptFiles]),
    run('vitest', ['run', ...targets]),
  ].filter((status) => status !== 0);
  process.exit(failures.length ? 1 : 0);
} else {
  console.error('usage: testbed.mjs sync | fix [paths...] | check [paths...]');
  process.exit(2);
}
