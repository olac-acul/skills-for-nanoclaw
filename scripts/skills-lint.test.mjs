import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const skillsRoot = '.claude/skills';
const skills = readdirSync(skillsRoot).filter((name) => existsSync(join(skillsRoot, name, 'SKILL.md')));

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

/** Lines of every `nc:copy` fence: `SRC -> DST`. */
function copyEntries(markdown) {
  const entries = [];
  for (const match of markdown.matchAll(/```nc:copy[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of match[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [src, dst] = line.split('->').map((part) => part.trim());
      entries.push({ src, dst: dst ?? src });
    }
  }
  return entries;
}

for (const name of skills) {
  const dir = join(skillsRoot, name);
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');

  test(`${name}: frontmatter has a name matching the folder and a description`, () => {
    const match = /^---\nname: (.+)\ndescription: (.+)\n(?:[\s\S]*?)---\n/.exec(skill);
    assert.ok(match, 'frontmatter missing');
    assert.equal(match[1].trim(), name);
    assert.ok(match[2].trim().length > 20);
  });

  test(`${name}: the copy block lists exactly the payload files`, () => {
    const payload = join(dir, 'payload');
    if (!existsSync(payload)) return;
    const onDisk = [...files(payload)].map((file) => `payload/${relative(payload, file)}`).sort();
    const listed = copyEntries(skill).map((entry) => entry.src).sort();
    assert.deepEqual(listed, onDisk);
    for (const entry of copyEntries(skill)) assert.equal(entry.dst, entry.src.replace(/^payload\//, ''), `${entry.src} should land at the same path without payload/`);
  });

  test(`${name}: REMOVE.md exists and names every installed file`, () => {
    const remove = join(dir, 'REMOVE.md');
    assert.ok(existsSync(remove), 'REMOVE.md missing');
    const text = readFileSync(remove, 'utf8');
    for (const entry of copyEntries(skill)) assert.ok(text.includes(entry.dst), `REMOVE.md does not mention ${entry.dst}`);
  });
}
