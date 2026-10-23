#!/usr/bin/env node
/**
 * Update a NanoClaw install from upstream and keep the skills of this repository working on it.
 *
 * It drives upstream's own transactional updater (`scripts/update-nanoclaw.ts` of upstream: prepare, validate,
 * cutover, finish, with its snapshot and automatic way back) and adds what that updater cannot know:
 *
 *   - the install's skills are local changes, so they are committed first (one "baseline" commit) because the
 *     updater needs a clean tree;
 *   - after upstream's changes are merged in a staging copy, this repository's skills are refreshed in it, the
 *     panel's import line is put back in the right place and the voice channel's core changes are checked,
 *     before anything is tested;
 *   - everything runs with umask 022 (some of upstream's tests depend on it; a normal login has 002);
 *   - the one requirement that stops every update that has it, upgrading the OneCLI gateway to the pinned version,
 *     is done here, with the database dump upstream's guide asks for, instead of by hand.
 *
 *   node scripts/update-install.mjs prepare [--install DIR] [--channel stable|beta|edge] [--remote NAME] [--yes]
 *   node scripts/update-install.mjs validate [--install DIR]      (tests the prepared copy again)
 *   node scripts/update-install.mjs cutover [--install DIR] [--yes]
 *   node scripts/update-install.mjs status  [--install DIR]
 *   node scripts/update-install.mjs abandon [--install DIR]
 *
 * `prepare` changes nothing that runs: it commits locally, stages, tests. `cutover` is the step with downtime
 * (service stopped, agent containers drained, image rebuilt, gateway upgraded if asked), and asks first.
 * Run it as the user that owns the install, from a checkout of this repository.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { commitAll, markerMatches, stampMarker } from './upgrade-marker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_REPO = path.resolve(HERE, '..');
export const OUR_SKILLS = ['add-manager-backup', 'add-manager-panel', 'add-voice', 'add-assistant-prompt'];

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/** The OneCLI gateway version an update requirement asks for, or null when it is another requirement. */
export function onecliTarget(requirement) {
  const text = `${requirement?.description ?? ''}`;
  if (!/OneCLI/i.test(text) || !/gateway/i.test(text)) return null;
  const match = /exactly\s+(\d+\.\d+\.\d+)/i.exec(text);
  return match ? match[1] : null;
}

/** Split requirements into the one this tool does itself and the ones that need a person. */
export function planRequirements(requirements) {
  const automatic = [];
  const manual = [];
  for (const requirement of requirements ?? []) {
    if (requirement.status && requirement.status !== 'pending') continue;
    (onecliTarget(requirement) ? automatic : manual).push(requirement);
  }
  return { automatic, manual };
}

/** Controller output is JSON on stdout; anything else on stdout means it did not get that far. */
export function parseControllerJson(stdout) {
  const text = `${stdout ?? ''}`.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start < 0) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
}

/** The one-line state of an update transaction for a person. */
export function describePhase(result) {
  if (!result) return 'no answer from the updater';
  const bits = [`phase ${result.phase}`];
  if (result.channel) bits.push(`channel ${result.channel}`);
  if (result.upstreamRef) bits.push(`from ${String(result.upstreamRef).replace(/^refs\/(tags|heads|remotes)\//, '')}`);
  return bits.join(', ');
}

/** `1.41.0` to `1.42.0` with a gateway version that is anything but a plain x.y.z is refused. */
export function validPin(value) {
  return /^\d+\.\d+\.\d+$/.test(value ?? '');
}

/** The commands that move the gateway to `pin`, as upstream's guide gives them (docs/onecli-upgrades.md). */
export function gatewayUpgradeScript(pin) {
  if (!validPin(pin)) throw new Error(`not a gateway version: ${pin}`);
  return `
set -e
cd ~/.onecli
(umask 077 && touch .env && { grep -v '^[[:space:]]*ONECLI_VERSION[[:space:]]*=' .env; echo "ONECLI_VERSION=${pin}"; } > .env.new && cat .env.new > .env && rm .env.new)
IMAGE=$(env -u ONECLI_VERSION docker compose config --images | grep onecli/onecli || true)
[ "$IMAGE" = "ghcr.io/onecli/onecli:${pin}" ] || { echo "the compose file would run '$IMAGE', not ${pin}: edit the onecli service to read ONECLI_VERSION first (docs/onecli-upgrades.md)" >&2; exit 1; }
(umask 077 && F=~/onecli-db-backup-$(date +%Y%m%d-%H%M%S).sql && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$F.part" && grep -q 'PostgreSQL database dump complete' "$F.part" && mv "$F.part" "$F" || { rm -f "$F.part"; echo "database backup failed, nothing was changed" >&2; exit 1; }; echo "gateway database saved in $F")
env -u ONECLI_VERSION docker compose pull onecli
env -u ONECLI_VERSION docker compose up -d
`;
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function say(text) {
  console.log(text);
}

function fail(text, code = 1) {
  console.error(`update: ${text}`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command = 'status', ...rest] = argv;
  const flags = { channel: undefined, remote: undefined, install: undefined, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--yes') flags.yes = true;
    else if (arg === '--install' || arg === '--channel' || arg === '--remote') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) fail(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
    } else fail(`unknown option ${arg}`);
  }
  if (flags.channel && !['stable', 'beta', 'edge'].includes(flags.channel)) fail('--channel is stable, beta or edge');
  return { command, flags };
}

async function confirm(question, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) fail(`${question} (not interactive: pass --yes to go ahead)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes' || answer === 's' || answer === 'si' || answer === 'sì';
}

class Install {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.stateDir = path.join(os.homedir(), '.nanoclaw-updates');
    this.pendingFile = path.join(this.stateDir, 'pending.json');
  }
  sh(command, options = {}) {
    return run('bash', ['-lc', command], { cwd: this.dir, ...options });
  }
  git(...args) {
    return run('git', args, { cwd: this.dir });
  }
  controller(controllerDir, subcommand, extra = []) {
    const result = run('pnpm', ['exec', 'tsx', path.join(controllerDir, 'scripts', 'update-nanoclaw.ts'), subcommand, '--project-root', this.dir, ...extra], {
      cwd: this.dir,
    });
    return { ...result, json: parseControllerJson(result.stdout) };
  }
  readPending() {
    try {
      return JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
    } catch {
      return null;
    }
  }
  writePending(value) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.pendingFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  }
  clearPending() {
    fs.rmSync(this.pendingFile, { force: true });
  }
}

function openInstall(flags) {
  const dir = flags.install ?? process.cwd();
  if (!fs.existsSync(path.join(dir, 'package.json')) || !fs.existsSync(path.join(dir, 'src', 'modules', 'index.ts')) || !fs.existsSync(path.join(dir, '.git')))
    fail(`${dir} is not a NanoClaw install (a git checkout with src/modules/index.ts): pass --install DIR`);
  return new Install(dir);
}

function preflight(install) {
  process.umask(0o022);
  // Upstream's updater asks systemd whether the service runs; from `su`/`runuser`/`sudo` there is no user bus unless
  // this points at the user's runtime directory (the user manager keeps running with lingering enabled).
  const runtimeDir = `/run/user/${process.getuid?.() ?? ''}`;
  if (!process.env.XDG_RUNTIME_DIR && fs.existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;
  for (const tool of ['git', 'pnpm', 'node']) if (run('bash', ['-lc', `command -v ${tool}`]).status !== 0) fail(`${tool} is not installed`);
  if (run('bash', ['-lc', 'command -v jq']).status !== 0) fail('jq is not installed (some of upstream\'s tests need it): apt install jq');
  for (const skill of OUR_SKILLS) if (!fs.existsSync(path.join(SKILLS_REPO, '.claude', 'skills', skill, 'SKILL.md'))) fail(`${skill} is missing from ${SKILLS_REPO}`);
  // Upstream's updater works on a branch. An install provisioned with `git checkout <commit>` is on none: put `main` on
  // the current commit, which is safe only when the local `main` has nothing that this commit lacks.
  if (install.git('symbolic-ref', '-q', 'HEAD').status !== 0) {
    const hasMain = install.git('rev-parse', '--verify', '-q', 'refs/heads/main').status === 0;
    // Nothing is lost when every commit of the local main is already in this commit or on a remote branch.
    const kept = hasMain && (install.git('merge-base', '--is-ancestor', 'refs/heads/main', 'HEAD').status === 0 || install.git('branch', '-r', '--contains', 'refs/heads/main').stdout.trim() !== '');
    if (hasMain && !kept) fail('this install is on a detached commit and its local branch main has commits that exist nowhere else: put the install on a branch by hand first');
    const switched = install.git('switch', '-q', '-C', 'main', 'HEAD');
    if (switched.status !== 0) fail(`could not put the install on the branch main: ${switched.stderr}`);
    say('the install was on a detached commit: it is now on the branch main, at the same commit');
  }
  if (install.git('config', 'user.name').stdout.trim() === '') {
    install.git('config', 'user.name', 'nanoclaw');
    install.git('config', 'user.email', 'nanoclaw@install.test');
    say('git identity set in this install (nanoclaw), for the commits of the update');
  }
}

function remoteOf(install, wanted) {
  if (wanted) return wanted;
  const remotes = install.git('remote').stdout.split('\n').filter(Boolean);
  for (const name of ['upstream', 'origin']) {
    const url = install.git('remote', 'get-url', name).stdout.trim();
    if (remotes.includes(name) && /nanocoai\/nanoclaw/.test(url)) return name;
  }
  install.git('remote', 'add', 'upstream', 'https://github.com/nanocoai/nanoclaw.git');
  return 'upstream';
}

/** Lock files that are only ever regenerated, never merged by hand. The command to rebuild each one comes with it. */
export const REGENERABLE_LOCKS = {
  'pnpm-lock.yaml': { cwd: '.', command: ['pnpm', 'install', '--lockfile-only'] },
  'container/agent-runner/bun.lock': { cwd: 'container/agent-runner', command: ['bun', 'install', '--lockfile-only'] },
};

/** Whether every conflicted file is one that can be regenerated, and which. */
export function lockOnlyConflict(files) {
  const names = (files ?? []).filter(Boolean);
  return names.length > 0 && names.every((name) => Object.hasOwn(REGENERABLE_LOCKS, name));
}

/**
 * A merge that conflicts only in lock files is settled in the staging copy: upstream's version of each lock file is
 * taken and rebuilt from the merged package.json (which already holds both sides' dependencies), then the merge is
 * committed. Returns an error text, or null when it worked. Anything else conflicted is left for a person.
 */
function settleLockConflicts(stageRoot) {
  const unmerged = run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: stageRoot }).stdout.split('\n').filter(Boolean);
  if (!lockOnlyConflict(unmerged)) return `conflicts that need a person: ${unmerged.join(', ') || '(unknown)'}`;
  for (const name of unmerged) {
    const take = run('git', ['checkout', '--theirs', '--', name], { cwd: stageRoot });
    if (take.status !== 0) return `could not take upstream's ${name}: ${take.stderr}`;
    const { cwd, command } = REGENERABLE_LOCKS[name];
    const rebuild = run(command[0], command.slice(1), { cwd: path.join(stageRoot, cwd) });
    if (rebuild.status !== 0) return `could not rebuild ${name}: ${(rebuild.stderr || rebuild.stdout).slice(-400)}`;
    run('git', ['add', '--', name], { cwd: stageRoot });
  }
  const commit = run('git', ['commit', '--no-edit'], { cwd: stageRoot });
  return commit.status === 0 ? null : `could not commit the merge: ${(commit.stderr || commit.stdout).slice(-300)}`;
}

/** The skills of this repository installed in `dir` (each has its folder under .claude/skills). */
export function installedSkills(dir) {
  return OUR_SKILLS.filter((skill) => fs.existsSync(path.join(dir, '.claude', 'skills', skill, 'SKILL.md')));
}

/**
 * Copy the newer version of the skills `dir` has into it (only those: an install without the voice channel must not
 * get its files), put the panel's import in place and check the core changes of the voice channel and of the
 * assistant prompt. A skill this install never had is added with install-skills.mjs, not here.
 */
function refreshSkills(dir) {
  const skills = installedSkills(dir);
  for (const skill of skills) {
    const source = path.join(SKILLS_REPO, '.claude', 'skills', skill);
    fs.cpSync(path.join(source, 'payload'), dir, { recursive: true });
    const target = path.join(dir, '.claude', 'skills', skill);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
  }
  const steps = [
    ['add-manager-panel', 'scripts/panel-barrel.mjs', "the panel's import could not be placed"],
    ['add-voice', 'scripts/voice-core-seams.mjs', "the voice channel's core changes no longer fit this upstream"],
    ['add-assistant-prompt', 'scripts/assistant-prompt-seams.mjs', "the assistant prompt's changes no longer fit this upstream"],
  ];
  for (const [skill, script, problem] of steps) {
    if (!skills.includes(skill)) continue;
    const result = run('node', [script], { cwd: dir });
    if (result.status !== 0) throw new Error(`${problem}:\n${result.stderr || result.stdout}`);
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Run upstream's validation on the staged update. The whole output is kept in a log; the failing tests are named. */
function runValidation(install, controllerDir, id, stageRoot) {
  const result = install.controller(controllerDir, 'validate', ['--id', id]);
  if (result.json?.phase === 'validated') return { ok: true, json: result.json };
  const full = `${result.json?.error ?? ''}\n${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  fs.mkdirSync(install.stateDir, { recursive: true, mode: 0o700 });
  const log = path.join(install.stateDir, `validate-${Date.now()}.log`);
  fs.writeFileSync(log, full, { mode: 0o600 });
  const failed = [...new Set(full.split('\n').filter((line) => /^\s*(FAIL|×)\s/.test(line)).map((line) => line.trim().slice(0, 200)))].slice(0, 12);
  const message = `validation failed (${describePhase(result.json)}). Failing tests:\n${failed.length ? failed.map((line) => `  ${line}`).join('\n') : '  (none named; see the log)'}\nFull output: ${log}`;
  return { ok: false, message, stageRoot };
}

async function validate(install, flags) {
  const pending = install.readPending();
  if (!pending || !['validation-failed', 'prepared', 'validated'].includes(pending.phase)) fail('no prepared update to test: run `prepare` first');
  preflight(install);
  say('Testing the copy again…');
  const validated = runValidation(install, pending.controllerDir, pending.id, pending.stageRoot);
  if (!validated.ok) fail(validated.message, 4);
  install.writePending({ ...pending, phase: 'validated' });
  say('The tests pass. The next step is `cutover`.');
}

async function prepare(install, flags) {
  if (install.readPending()) fail('an update is already prepared: run `cutover` to finish it or `abandon` to drop it');
  preflight(install);
  // The host checks its upgrade marker against HEAD at every start: one that does not match now means the code changed
  // outside the sanctioned paths, and committing over it would hide that.
  if (!markerMatches(install.dir)) {
    fail(
      "NanoClaw's upgrade marker does not match this checkout (the code changed outside the sanctioned paths, or a commit " +
        'was made after it was written): sort that out first, see docs/upgrade-recovery.md. Nothing was changed.',
    );
  }
  const status = install.git('status', '--porcelain').stdout.trim();
  if (status) {
    const lines = status.split('\n');
    say(`The install has ${lines.length} local changes. The updater needs a clean tree, so they are committed as one baseline commit:`);
    for (const line of lines.slice(0, 20)) say(`  ${line}`);
    if (lines.length > 20) say(`  … and ${lines.length - 20} more (git status)`);
    if (!(await confirm('Commit them?', flags.yes))) fail('nothing was changed');
    const committed = commitAll(install.dir, 'local: skills installed (baseline before the update)');
    if (committed) fail(`the baseline commit failed (a commit hook?):\n${committed}`);
    // The marker records the new HEAD, or the next restart of the host (and upstream's own rollback) would refuse to start.
    const stamped = stampMarker(install.dir, 'skills-baseline');
    if (stamped) fail(`the baseline commit was made but the upgrade marker could not be written: ${stamped}\nRun \`pnpm exec tsx scripts/upgrade-state.ts set\` in the install before restarting it.`);
  }
  const remote = remoteOf(install, flags.remote);
  const fetch = install.git('fetch', remote, '--prune');
  if (fetch.status !== 0) fail(`git fetch ${remote} failed: ${fetch.stderr}`);
  const controllerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-controller-'));
  const archive = run('bash', ['-lc', `git archive ${remote}/main scripts src/install-slug.ts | tar -x -C ${JSON.stringify(controllerDir)}`], { cwd: install.dir });
  if (archive.status !== 0) fail(`could not load the updater from ${remote}/main: ${archive.stderr}`);

  say('Preparing the update in a separate copy (the install is not touched)…');
  const prepared = install.controller(controllerDir, 'prepare', ['--remote', remote, '--strategy', 'merge', ...(flags.channel ? ['--channel', flags.channel] : [])]);
  if (!prepared.json) fail(`the updater gave no answer:\n${prepared.stderr.slice(-1500)}`);
  say(describePhase(prepared.json));
  if (prepared.json.phase === 'prepared' && prepared.json.targetHead === prepared.json.originalHead) {
    install.controller(controllerDir, 'abandon', ['--id', prepared.json.id]);
    say('Already on the newest version of NanoClaw. Nothing to do here.');
    say('Newer versions of these skills alone are installed with: node scripts/install-skills.mjs --install <the install folder>');
    return;
  }
  if (prepared.json.phase === 'conflict') {
    say('The merge conflicts; checking whether only lock files are involved…');
    const problem = settleLockConflicts(prepared.json.stageRoot);
    if (problem) {
      say(`${problem}`);
    } else {
      say('Only lock files conflicted: they were rebuilt from the merged package.json and the merge was committed.');
      const resumed = install.controller(controllerDir, 'resume', ['--id', prepared.json.id]);
      if (resumed.json) {
        prepared.json = { ...prepared.json, ...resumed.json };
        say(describePhase(prepared.json));
      }
    }
  }
  if (prepared.json.phase !== 'prepared') {
    say(`\nThe merge needs a person: resolve it in ${prepared.json.stageRoot}, then run:\n  pnpm exec tsx ${controllerDir}/scripts/update-nanoclaw.ts resume --project-root ${install.dir} --id ${prepared.json.id}`);
    if (prepared.json.lastError) say(`\n${String(prepared.json.lastError).slice(0, 600)}`);
    install.writePending({ id: prepared.json.id, controllerDir, stageRoot: prepared.json.stageRoot, phase: prepared.json.phase, remote });
    process.exit(3);
  }

  say('Refreshing this repository\'s skills in the copy…');
  try {
    refreshSkills(prepared.json.stageRoot);
  } catch (error) {
    install.controller(controllerDir, 'abandon', ['--id', prepared.json.id]);
    fail(`${error.message}\nThe prepared update was dropped; the install keeps running as it was.`);
  }
  const stage = (...args) => run('git', args, { cwd: prepared.json.stageRoot });
  stage('add', '-A');
  if (stage('status', '--porcelain').stdout.trim()) {
    const commit = stage('commit', '-q', '-m', 'local: our skills refreshed on the new upstream');
    if (commit.status !== 0) fail(`committing the refreshed skills in the copy failed:\n${commit.stderr || commit.stdout}`);
  }

  say('Testing the copy (build and the whole test suite; a few minutes)…');
  const validated = runValidation(install, controllerDir, prepared.json.id, prepared.json.stageRoot);
  if (!validated.ok) {
    install.writePending({ id: prepared.json.id, controllerDir, stageRoot: prepared.json.stageRoot, phase: 'validation-failed', remote, requirements: prepared.json.requirements ?? [], channel: prepared.json.channel, upstreamRef: prepared.json.upstreamRef });
    fail(`${validated.message}\nThe install keeps running as it was. Run \`validate\` to try the tests again (a test can fail by chance under load), or fix it in ${prepared.json.stageRoot}, or \`abandon\`.`, 4);
  }

  const requirements = prepared.json.requirements ?? [];
  const plan = planRequirements(requirements);
  install.writePending({
    id: prepared.json.id,
    controllerDir,
    stageRoot: prepared.json.stageRoot,
    phase: 'validated',
    remote,
    channel: prepared.json.channel,
    upstreamRef: prepared.json.upstreamRef,
    requirements,
  });
  say(`\nReady: ${describePhase(validated.json)}.`);
  say(`Upstream changes: ${(prepared.json.changedFiles ?? []).length} files.`);
  for (const requirement of plan.automatic) say(`Requirement done by this tool: upgrade the OneCLI gateway to ${onecliTarget(requirement)} (with a database dump first).`);
  for (const requirement of plan.manual) say(`Requirement for a person: ${String(requirement.description).slice(0, 300)}`);
  say('\nNothing running has changed. The next step, `cutover`, stops the service for a while.');
}

async function cutover(install, flags) {
  const pending = install.readPending();
  if (!pending || pending.phase !== 'validated') fail('no validated update is waiting: run `prepare` first');
  preflight(install);
  const plan = planRequirements(pending.requirements);
  if (plan.manual.length > 0) {
    for (const requirement of plan.manual) say(`This update has a requirement this tool does not do: ${String(requirement.description).slice(0, 400)}`);
    fail('do those by hand (upstream\'s guides), or use upstream\'s own /update-nanoclaw for this update', 5);
  }
  say(`About to update ${install.dir}: ${describePhase({ phase: 'cutover', channel: pending.channel, upstreamRef: pending.upstreamRef })}.`);
  say('This stops the service and the agents\' containers, rebuilds the image if needed, and starts again. Plan for several minutes without the assistant.');
  if (!(await confirm('Go ahead?', flags.yes))) fail('nothing was changed');

  const cut = install.controller(pending.controllerDir, 'cutover', ['--id', pending.id]);
  if (!cut.json || cut.json.phase !== 'cutover') fail(`cutover did not complete (${describePhase(cut.json)}):\n${cut.stderr.slice(-1500)}\nUpstream's updater restores the previous state on a build failure; check \`status\`.`, 6);
  say(`Cut over: ${describePhase(cut.json)}.`);

  for (const requirement of plan.automatic) {
    const pin = onecliTarget(requirement);
    say(`Upgrading the OneCLI gateway to ${pin} (database dump first)…`);
    const upgrade = install.sh(gatewayUpgradeScript(pin));
    say(upgrade.stdout.trim().split('\n').filter((line) => /saved|Pulled|Started|Healthy/.test(line)).join('\n'));
    if (upgrade.status !== 0) fail(`the gateway upgrade failed: ${upgrade.stderr.slice(-800)}\nThe update is cut over but not finished. The way back: restore the previous gateway version (docs/onecli-upgrades.md, section Rollback).`, 7);
    const health = install.sh(`sleep 12; GW=$(grep -E '^ONECLI_URL=' .env | cut -d= -f2- | tr -d "\\"' "); curl -s "$GW/v1/health"; echo; docker inspect -f '{{.Config.Image}}' onecli`);
    if (!health.stdout.includes('"status":"ok"') || !health.stdout.includes(`:${pin}`)) fail(`the gateway does not report ${pin} and ok:\n${health.stdout}`, 7);
    say(`Gateway running ${pin}, health ok.`);
    const ack = install.controller(pending.controllerDir, 'ack', [
      '--id',
      pending.id,
      '--requirement',
      requirement.id,
      '--status',
      'succeeded',
      '--rollback',
      `set ONECLI_VERSION back to the previous version in ~/.onecli/.env, then: cd ~/.onecli && env -u ONECLI_VERSION docker compose pull onecli && env -u ONECLI_VERSION docker compose up -d (database dump: ~/onecli-db-backup-*.sql)`,
    ]);
    if (ack.status !== 0) fail(`the requirement could not be recorded: ${ack.stderr.slice(-600)}`);
  }

  const finished = install.controller(pending.controllerDir, 'finish', ['--id', pending.id]);
  if (!finished.json || finished.json.phase !== 'complete') fail(`finish did not complete (${describePhase(finished.json)}):\n${finished.stderr.slice(-1200)}`, 8);
  say(`Finished: ${describePhase(finished.json)}.`);

  // A host that nothing manages (started by hand) is not restarted by the updater: start it the way it was started.
  const running = install.sh('pgrep -f "^node dist/index.js" >/dev/null && echo yes || echo no').stdout.trim();
  const managed = install.sh('systemctl --user list-units --no-legend 2>/dev/null | grep -c nanoclaw-v2 || true').stdout.trim();
  if (running === 'no' && managed === '0') {
    say('No service manages this host and it is not running: starting it by hand.');
    install.sh('nohup node dist/index.js >> logs/nanoclaw.log 2>&1 < /dev/null &');
    run('sleep', ['12']);
  }
  const checks = install.sh(
    [
      'echo "host: $(pgrep -f "dist/index.js" >/dev/null && echo running || echo NOT running)"',
      'tail -n 150 logs/nanoclaw.log | sed -E "s/\\x1b\\[[0-9;]*m//g" | grep -E "Voice channel listening|Manager panel listening|NanoClaw running|FATAL" | tail -4 | cut -c1-120',
      'test -f data/voice-status.json && echo "voice status file: present" || true',
    ].join('; '),
  );
  say(checks.stdout.trim());
  install.controller(pending.controllerDir, 'cleanup', ['--id', pending.id]);
  install.clearPending();
  say('\nDone. The rollback point (git tag and the state snapshot) is kept by upstream\'s updater.');
}

async function status(install) {
  const pending = install.readPending();
  say(pending ? `Prepared update: ${pending.id} (${pending.phase}) in ${pending.stageRoot}` : 'No update is prepared.');
  say(`Install at: ${install.git('log', '--oneline', '-1').stdout.trim()}`);
}

async function abandon(install) {
  const pending = install.readPending();
  if (!pending) return say('No update is prepared.');
  if (fs.existsSync(path.join(pending.controllerDir, 'scripts', 'update-nanoclaw.ts'))) {
    const result = install.controller(pending.controllerDir, 'abandon', ['--id', pending.id]);
    if (result.status !== 0) say(`the updater said: ${result.stderr.slice(-300)}`);
  }
  install.clearPending();
  say('The prepared update was dropped. The install keeps running as it was.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const install = openInstall(flags);
  const table = { prepare, validate, cutover, status, abandon };
  if (!table[command]) fail(`unknown command ${command}; use prepare, validate, cutover, status or abandon`);
  await table[command](install, flags);
}
