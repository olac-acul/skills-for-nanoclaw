#!/usr/bin/env node
/**
 * Keep each skill's file lists in step with its payload directory:
 *  - the body of the `nc:copy` fence in SKILL.md, and
 *  - the ```text files fence in REMOVE.md.
 * Run after adding or removing a payload file; `scripts/skills-lint.test.mjs`
 * fails when they drift.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = '.claude/skills';

function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

for (const name of readdirSync(root)) {
  const dir = join(root, name);
  const payload = join(dir, 'payload');
  if (!existsSync(join(dir, 'SKILL.md')) || !existsSync(payload)) continue;
  const list = [...files(payload)].map((file) => relative(payload, file)).sort();

  const skillPath = join(dir, 'SKILL.md');
  let skill = readFileSync(skillPath, 'utf8');
  skill = skill.replace(/(```nc:copy[^\n]*\n)[\s\S]*?(```)/, (_m, open, close) => `${open}${list.map((f) => `payload/${f} -> ${f}`).join('\n')}\n${close}`);
  writeFileSync(skillPath, skill);

  const removePath = join(dir, 'REMOVE.md');
  if (existsSync(removePath)) {
    let remove = readFileSync(removePath, 'utf8');
    remove = remove.replace(/(```text files\n)[\s\S]*?(```)/, (_m, open, close) => `${open}${list.join('\n')}\n${close}`);
    writeFileSync(removePath, remove);
  }
  console.log(`${name}: ${list.length} payload files`);
}
