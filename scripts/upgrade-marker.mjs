/**
 * NanoClaw's upgrade marker (data/upgrade-state.json) records the version, commit and tree of the checkout that last
 * went through a sanctioned path; at every start the host compares it with HEAD and refuses to run when they differ
 * (upstream's upgrade tripwire, docs/upgrade-recovery.md). Uncommitted changes are invisible to it: what matters is
 * that the marker is written after a commit, not before.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const gitRev = (dir, rev) => {
  const result = spawnSync('git', ['rev-parse', '--verify', rev], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** True when the marker matches the checkout as upstream checks it: package.json version, HEAD and its tree. */
export function markerMatches(dir) {
  let marker;
  let version;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'upgrade-state.json'), 'utf8'));
    version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return false;
  }
  if (!marker || marker.version !== version) return false;
  const commit = gitRev(dir, 'HEAD');
  const tree = gitRev(dir, 'HEAD^{tree}');
  if (!commit || !tree) return true; // no Git: upstream accepts the version alone
  return marker.commit === commit && marker.tree === tree;
}

/** Writes the marker for the checkout as it is now, with upstream's own script. Returns null or an error message. */
export function stampMarker(dir, via) {
  const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set', '', via], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? null : (result.stderr || result.stdout || `exit ${result.status}`).trim();
}

/** The tree has no changes at all, tracked or untracked (ignored files do not count). */
export function treeIsClean(dir) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === '';
}

/**
 * Commits every change of the tree as one local commit; with no change, nothing. A missing Git identity is not a reason to fail: the commit
 * is then signed as the skills installer. Returns null or an error message.
 */
export function commitAll(dir, message) {
  const add = spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  if (add.status !== 0) return (add.stderr || 'git add failed').trim();
  if (treeIsClean(dir)) return null; // nothing changed (a skill applied again as it was): no empty commit
  const identity = spawnSync('git', ['config', 'user.email'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
    ? []
    : ['-c', 'user.name=NanoClaw skills installer', '-c', 'user.email=skills-installer@localhost'];
  const commit = spawnSync('git', [...identity, 'commit', '-q', '-m', message], { cwd: dir, encoding: 'utf8' });
  return commit.status === 0 ? null : (commit.stderr || commit.stdout || 'git commit failed').trim();
}
