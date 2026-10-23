#!/usr/bin/env node
/**
 * Apply this repository's skills to a NanoClaw install with upstream's own skill engine, then record the new state
 * and restart the service. It is what `compose.mjs` does on a throw-away checkout, done on a real install.
 *
 *   node scripts/install-skills.mjs --install DIR [--skills add-manager-backup,add-manager-panel,add-voice,add-assistant-prompt]
 *                                    [--no-restart] [--no-commit]
 *
 * It is also how newer versions of these skills reach an install whose NanoClaw has not changed (when
 * `update-install.mjs` finds nothing new upstream): run it again from an updated checkout of this repository.
 *
 * Run it as the user that owns the install. Each skill checks its prerequisites, copies its files, builds and runs
 * its tests; applying one again is safe.
 *
 * Then the result is committed as one local commit and NanoClaw's upgrade marker is written for that commit: the host
 * compares the marker with HEAD at every start and refuses to run when they differ, so a commit made after the marker
 * would stop the next restart. Not when the install already had other uncommitted changes (they are not swept into the
 * commit: commit them yourself, then `pnpm exec tsx scripts/upgrade-state.ts set`), nor with --no-commit. A marker
 * that did not match already before is said out loud (upstream's setup can commit after stamping it, so a fresh
 * install may start that way; a raw `git pull` would too): see upstream's docs/upgrade-recovery.md.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPLY_RUNNER } from './skill-runner.mjs';
import { commitAll, markerMatches, stampMarker, treeIsClean } from './upgrade-marker.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SKILLS = ['add-manager-backup', 'add-manager-panel', 'add-voice', 'add-assistant-prompt'];

function fail(message) {
  console.error(`install-skills: ${message}`);
  process.exit(1);
}

export function parseArgs(argv) {
  const flags = { install: null, skills: DEFAULT_SKILLS, restart: true, commit: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--install') flags.install = argv[++i];
    else if (arg === '--skills') flags.skills = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--no-restart') flags.restart = false;
    else if (arg === '--no-commit') flags.commit = false;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!flags.install) throw new Error('--install DIR is required');
  const unknown = flags.skills.filter((s) => !DEFAULT_SKILLS.includes(s));
  if (unknown.length) throw new Error(`not a skill of this repository: ${unknown.join(', ')}`);
  if (flags.skills.includes('add-manager-panel') && !flags.skills.includes('add-manager-backup'))
    throw new Error('add-manager-panel needs add-manager-backup');
  // The engine applies them in this order: the panel uses the backup library.
  flags.skills = DEFAULT_SKILLS.filter((s) => flags.skills.includes(s));
  return flags;
}

function run(command, args, cwd, quiet = false) {
  if (!quiet) console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
  if (result.status !== 0) fail(`"${command} ${args.join(' ')}" failed (${result.status ?? result.signal})`);
}

/** Group folders whose instructions already carry the voice channel's section (marker of the add-voice skill). */
export function foldersWithVoiceSection(install) {
  const groups = path.join(install, 'groups');
  if (!fs.existsSync(groups)) return [];
  return fs
    .readdirSync(groups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const file = path.join(groups, name, 'instructions.prepend.md');
      return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('<!-- nanovoice:begin');
    })
    .sort();
}

function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const install = path.resolve(flags.install);
  for (const file of ['package.json', 'scripts/skill-apply.ts', 'scripts/skill-directives.ts', 'src/cli/client.ts'])
    if (!fs.existsSync(path.join(install, file))) fail(`${install} is not a NanoClaw install (${file} is missing)`);
  process.umask(0o022); // some of upstream's tests depend on it; a login shell often has 002
  // Read before anything changes: whether the skills can be committed alone, and whether the marker was in order.
  const wasClean = treeIsClean(install);
  const markerWasCurrent = markerMatches(install);

  fs.mkdirSync(path.join(install, '.claude', 'skills'), { recursive: true });
  // A skill already installed is refreshed first (the engine's install mode never replaces a file that exists).
  const installed = new Set(flags.skills.filter((name) => fs.existsSync(path.join(install, '.claude', 'skills', name, 'SKILL.md'))));
  for (const name of flags.skills) {
    const target = path.join(install, '.claude', 'skills', name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(repo, '.claude', 'skills', name), target, { recursive: true });
  }
  const runner = path.join(install, 'scripts', '__apply-skill.mts');
  fs.writeFileSync(runner, APPLY_RUNNER);
  try {
    for (const name of flags.skills) {
      console.log(`\n=== ${name}`);
      run('pnpm', ['exec', 'tsx', 'scripts/skill-directives.ts', `.claude/skills/${name}/SKILL.md`], install, true);
      // Refresh replaces its files and dependencies; install then runs its checks, builds and tests.
      if (installed.has(name)) run('pnpm', ['exec', 'tsx', 'scripts/__apply-skill.mts', name, 'refresh'], install);
      run('pnpm', ['exec', 'tsx', 'scripts/__apply-skill.mts', name], install);
      console.log(`install-skills: ${name} ${installed.has(name) ? 'refreshed' : 'applied'}`);
    }
  } finally {
    fs.rmSync(runner, { force: true });
  }

  // A newer add-voice can change the agent's voice instructions: bring them up to date where they are in use.
  if (flags.skills.includes('add-voice'))
    for (const folder of foldersWithVoiceSection(install))
      run('pnpm', ['exec', 'tsx', 'scripts/voice-setup.ts', 'instructions', '--folder', folder], install);

  run('pnpm', ['run', 'build'], install);

  // The marker belongs to HEAD: commit the skills first, then record that commit.
  if (!markerWasCurrent) {
    console.warn(
      '\ninstall-skills: NOTE: the upgrade marker did not match this checkout already before the skills were installed. ' +
        'Right after upstream\'s setup that is expected; otherwise the code changed outside the sanctioned paths ' +
        '(a raw `git pull`?): check `git log` against `pnpm exec tsx scripts/upgrade-state.ts get` (docs/upgrade-recovery.md).',
    );
  }
  if (!flags.commit) {
    console.log('\ninstall-skills: --no-commit: commit the changes, then run `pnpm exec tsx scripts/upgrade-state.ts set`.');
  } else if (!wasClean) {
    console.log(
      '\ninstall-skills: the install had other uncommitted changes, so nothing was committed. Commit them together with ' +
        'the skills, then run `pnpm exec tsx scripts/upgrade-state.ts set` before the next restart.',
    );
  } else {
    const repoHead = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim() || 'unknown';
    const committed = commitAll(install, `local: skills installed with install-skills.mjs (${flags.skills.join(', ')}; skills-for-nanoclaw ${repoHead})`);
    if (committed) fail(`the skills are applied but could not be committed: ${committed}`);
    const stamped = stampMarker(install, 'skills');
    if (stamped) fail(`the skills are committed but the upgrade marker could not be written: ${stamped}`);
    console.log('\ninstall-skills: committed (if anything changed), and the upgrade marker records HEAD');
  }
  if (flags.restart) {
    if (!fs.existsSync(path.join(install, 'setup', 'lib', 'restart.sh'))) fail('setup/lib/restart.sh is missing: restart NanoClaw by hand');
    run('bash', ['setup/lib/restart.sh'], install);
  }
  console.log(`\ninstall-skills: ${flags.skills.join(', ')} installed in ${install}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
