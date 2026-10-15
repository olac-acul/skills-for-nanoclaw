/**
 * The small program that applies one skill with upstream's engine (`scripts/skill-apply.ts` of the install). It is
 * written into the install as `scripts/__apply-skill.mts`, run with tsx from the install's root, and removed after.
 * Second argument `refresh`: the engine's refresh mode (replaces the skill's files and dependencies, skips checks,
 * builds and tests); otherwise install mode (copies only what is missing, then checks, builds, tests).
 * Exit 3 means the skill left work the engine cannot do alone (a deferred step or a task for an agent).
 */
export const APPLY_RUNNER = `
import { execSync } from 'node:child_process';
import path from 'node:path';
import { applySkill } from './skill-apply.js';

const name = process.argv[2];
const mode = process.argv[3] === 'refresh' ? 'refresh' : 'install';
const root = process.cwd();
const result = await applySkill(path.join(root, '.claude/skills', name), root, {
  mode,
  exec: (cmd) => {
    const out = execSync(cmd, { cwd: root, shell: '/bin/bash', encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    process.stdout.write(out);
    return out;
  },
});
console.log('\\nAPPLY-RESULT ' + JSON.stringify({ mode, applied: result.applied.length, skipped: result.skipped.length, deferred: result.deferred, agentTasks: result.agentTasks.map((t) => t.reason ?? t) }));
if (result.deferred.length || result.agentTasks.length) process.exit(3);
`;
