#!/usr/bin/env node
/**
 * Update rehearsal: run update-install.mjs on a composed tree (scripts/compose.mjs) against a local stand-in for
 * upstream that has one more commit, the way an install meets a new upstream release. Two cases:
 *
 *  - a clean merge: `prepare` commits the installed skills as the baseline, stamps the upgrade marker, merges with
 *    upstream's own updater, refreshes the skills in the copy and passes upstream's validation; `abandon` drops it;
 *  - a conflict outside the lock files: `prepare` stops with exit 3 and keeps the update for a person; `abandon`.
 *
 * `--channel edge` follows the stand-in's main: the composed tree is already on upstream's main, ahead of the newest
 * release, so the default stable channel would refuse to move it back.
 * The install itself is never cut over (that needs the systemd service). This is the nightly job's second step.
 *
 *   node scripts/update-rehearsal.mjs [--workdir DIR]     (default: the compose work tree, .testbed/compose)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markerMatches, stampMarker, treeIsClean } from './upgrade-marker.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = process.argv.indexOf('--workdir');
const workdir = path.resolve(at > 0 ? process.argv[at + 1] : path.join(repo, '.testbed', 'compose'));
const updater = path.join(repo, 'scripts', 'update-install.mjs');

function fail(message) {
  console.error(`update-rehearsal: ${message}`);
  process.exit(1);
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

function update(command, extra = []) {
  console.log(`\n== update-install ${command}`);
  const result = spawnSync('node', [updater, command, '--install', workdir, ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return result.status;
}

/** A bare stand-in for upstream: the tree's own upstream commit plus one commit made by `change`. */
function fakeUpstream(base, name, change) {
  const bare = path.join(scratch, `${name}.git`);
  git(scratch, 'clone', '-q', '--bare', '--no-local', workdir, bare);
  git(bare, 'update-ref', 'refs/heads/main', base);
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const clone = path.join(scratch, name);
  git(scratch, 'clone', '-q', bare, clone);
  change(clone);
  git(clone, 'add', '-A');
  git(clone, '-c', 'user.name=rehearsal', '-c', 'user.email=rehearsal@example.test', 'commit', '-q', '-m', `rehearsal: ${name}`);
  git(clone, 'push', '-q', 'origin', 'main');
  git(workdir, 'remote', 'remove', 'rehearsal');
  git(workdir, 'remote', 'add', 'rehearsal', bare);
}

if (!fs.existsSync(path.join(workdir, 'src', 'modules', 'index.ts'))) fail(`${workdir} is not a composed tree: run scripts/compose.mjs first`);
if (treeIsClean(workdir)) fail('the composed tree has no installed skills to commit as a baseline');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'update-rehearsal-'));
const base = git(workdir, 'rev-parse', 'HEAD');
spawnSync('git', ['remote', 'remove', 'rehearsal'], { cwd: workdir }); // left by an interrupted run
git(workdir, 'remote', 'add', 'rehearsal', scratch); // replaced by each stand-in
git(workdir, 'config', 'user.name', 'rehearsal');
git(workdir, 'config', 'user.email', 'rehearsal@example.test');

// The marker as a real install has it: written at the last commit, the skills' changes on top, uncommitted.
const stamped = stampMarker(workdir, 'rehearsal');
if (stamped) fail(`could not write the upgrade marker: ${stamped}`);

// 1. A clean merge: upstream changed a file no skill touches.
fakeUpstream(base, 'clean', (dir) => fs.appendFileSync(path.join(dir, 'README.md'), '\nA line from the update rehearsal.\n'));
let status = update('prepare', ['--remote', 'rehearsal', '--channel', 'edge', '--yes']);
if (status !== 0) fail(`prepare of a clean merge ended with exit ${status}`);
if (git(workdir, 'rev-parse', 'HEAD') === base) fail('prepare made no baseline commit');
if (!treeIsClean(workdir)) fail('the baseline commit left changes behind');
if (!markerMatches(workdir)) fail('the upgrade marker does not match the baseline commit');
if (update('status') !== 0) fail('status failed');
if (update('abandon') !== 0) fail('abandon failed');

// 2. A conflict a person must settle: upstream adds a module import where the panel put its own.
const baseline = git(workdir, 'rev-parse', 'HEAD');
fakeUpstream(base, 'conflict', (dir) => {
  const barrel = path.join(dir, 'src', 'modules', 'index.ts');
  const text = fs.readFileSync(barrel, 'utf8');
  const anchor = "import './self-mod/index.js';\n";
  if (!text.includes(anchor)) fail(`upstream's modules barrel has no ${anchor.trim()} line to put a conflict next to`);
  fs.writeFileSync(barrel, text.replace(anchor, `${anchor}import './rehearsal/index.js';\n`));
});
status = update('prepare', ['--remote', 'rehearsal', '--channel', 'edge', '--yes']);
if (status !== 3) fail(`prepare of a conflicting merge ended with exit ${status}, not 3`);
if (git(workdir, 'rev-parse', 'HEAD') !== baseline) fail('a conflicting prepare changed the install');
if (update('abandon') !== 0) fail('abandon after the conflict failed');

git(workdir, 'remote', 'remove', 'rehearsal');
fs.rmSync(scratch, { recursive: true, force: true });
console.log('\nupdate-rehearsal: both cases behaved as expected');
