#!/usr/bin/env node
/**
 * Composition check: apply every skill in this repo to a clean checkout of
 * upstream NanoClaw using upstream's own skill engine, then let each skill's
 * build and test steps run. This is what the nightly CI job does, and the
 * check to run before trusting a new upstream release.
 *
 *   node scripts/compose.mjs [--upstream URL|PATH] [--ref BRANCH] [--workdir DIR] [--skills a,b] [--full]
 *
 * --full also runs upstream's complete test suite on the composed tree.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(arg.slice(2), next);
    i++;
  } else {
    args.set(arg.slice(2), true);
  }
}

const upstream = args.get('upstream') ?? 'https://github.com/nanocoai/nanoclaw.git';
const ref = args.get('ref');
const workdir = resolve(args.get('workdir') ?? join(repo, '.testbed', 'compose'));
const skillsRoot = join(repo, '.claude', 'skills');
const allSkills = readdirSync(skillsRoot).filter((name) => existsSync(join(skillsRoot, name, 'SKILL.md'))).sort();
const skills = typeof args.get('skills') === 'string' ? args.get('skills').split(',') : allSkills;

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`compose: "${command} ${commandArgs.join(' ')}" failed (${result.status ?? result.signal})`);
    process.exit(1);
  }
}

rmSync(workdir, { recursive: true, force: true });
mkdirSync(dirname(workdir), { recursive: true });
run('git', ['clone', '--quiet', ...(ref ? ['--branch', ref] : []), upstream, workdir]);
run('pnpm', ['install', '--frozen-lockfile'], { cwd: workdir });
// The native SQLite binding is not built by default under pnpm's script policy.
run('pnpm', ['rebuild', 'better-sqlite3'], { cwd: workdir });

mkdirSync(join(workdir, '.claude', 'skills'), { recursive: true });
for (const name of skills) {
  rmSync(join(workdir, '.claude', 'skills', name), { recursive: true, force: true });
  cpSync(join(skillsRoot, name), join(workdir, '.claude', 'skills', name), { recursive: true });
}

const runner = `
import { execSync } from 'node:child_process';
import path from 'node:path';
import { applySkill } from './skill-apply.js';

const name = process.argv[2];
const root = process.cwd();
const result = await applySkill(path.join(root, '.claude/skills', name), root, {
  mode: 'install',
  exec: (cmd) => {
    const out = execSync(cmd, { cwd: root, shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    process.stdout.write(out);
    return out;
  },
});
console.log('\\nAPPLY-RESULT ' + JSON.stringify({ applied: result.applied.length, skipped: result.skipped.length, deferred: result.deferred, agentTasks: result.agentTasks.map((t) => t.reason ?? t) }));
if (result.deferred.length || result.agentTasks.length) process.exit(3);
`;
writeFileSync(join(workdir, 'scripts', '__apply-skill.mts'), runner);

for (const name of skills) {
  run('pnpm', ['exec', 'tsx', 'scripts/skill-directives.ts', `.claude/skills/${name}/SKILL.md`], { cwd: workdir, stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`compose: ${name} lints clean`);
  run('pnpm', ['exec', 'tsx', 'scripts/__apply-skill.mts', name], { cwd: workdir });
  console.log(`compose: ${name} applied`);
}
rmSync(join(workdir, 'scripts', '__apply-skill.mts'));

if (args.has('full')) run('pnpm', ['test'], { cwd: workdir });
console.log(`\ncompose: ${skills.length} skill(s) applied to ${upstream}${ref ? `@${ref}` : ''} in ${workdir}`);
