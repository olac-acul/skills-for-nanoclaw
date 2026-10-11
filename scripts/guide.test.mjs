import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SAFE_LINK, TARGET, generatedModule, headingIds, renderMarkdown, slugify } from './build-guide.mjs';

const guide = readFileSync('docs/guide.md', 'utf8');
const ui = readFileSync('.claude/skills/add-manager-panel/payload/src/modules/manager-panel/ui.ts', 'utf8');
const ids = new Set(headingIds(guide));

test('the generated guide module is up to date (run: node scripts/build-guide.mjs)', () => {
  assert.equal(readFileSync(TARGET, 'utf8'), generatedModule(guide));
});

test('heading ids are unique and stable', () => {
  const list = headingIds(guide);
  assert.equal(new Set(list).size, list.length);
  assert.equal(slugify('After installing: the upgrade check'), 'after-installing-the-upgrade-check');
  assert.equal(slugify('`ncl` & friends (v2)'), 'ncl-friends-v2');
});

test('every internal link in the guide points at a heading', () => {
  const missing = [...guide.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]).filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('every guide link in the panel UI points at a heading', () => {
  const anchors = new Set([
    ...[...ui.matchAll(/guide\('([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...ui.matchAll(/\['([a-z][a-z0-9-]+)', '[A-Z]/g)].map((m) => m[1]),
  ]);
  assert.ok(anchors.size >= 12, `expected the UI to link to many sections, found ${anchors.size}`);
  assert.deepEqual([...anchors].filter((id) => !ids.has(id)), []);
});

test('the terminal-only index covers every task the panel links to', () => {
  const section = guide.slice(guide.indexOf('## Terminal-only tasks'), guide.indexOf('### Forgotten password'));
  for (const id of ['create-the-administrator', 'forgotten-password', 'api-keys', 'restoring-a-backup', 'rehearsal-restore', 'retention-and-pruning', 'https-and-network-access', 'channels-and-agents', 'updating-nanoclaw', 'rebuilding-agent-images', 'removing-the-skills']) {
    assert.ok(section.includes(`](#${id})`), `index misses ${id}`);
  }
});

test('the renderer escapes HTML and keeps lists, code and tables intact', () => {
  const html = renderMarkdown('# T\n\nA <script>alert(1)</script> & `x<y`\n\n1. one\n\n   ```\n   code\n   ```\n\n2. two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<code>x&lt;y</code>'));
  assert.match(html, /<ol><li>one\n<pre><code>code<\/code><\/pre><\/li><li>two<\/li><\/ol>/);
  assert.match(html, /<table>.*<th>a<\/th>.*<td>2<\/td>/s);
});

test('author comments never reach the page', () => {
  const html = renderMarkdown('Text <!-- privacy-scan: allow --> more\n');
  assert.ok(!html.includes('privacy-scan'));
  assert.ok(!html.includes('--&gt;'));
  assert.match(html, /<p>Text more<\/p>/);
});

test('link targets use an allowed scheme and unsafe ones render as plain text', () => {
  const markdown = readFileSync('docs/guide.md', 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, , url] of markdown.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) assert.match(url, SAFE_LINK, `unsafe link target: ${url}`);
  const html = renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com) [d](#top)');
  assert.ok(!/href="(javascript|data):/i.test(html));
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">c<\/a>/);
  assert.match(html, /<a href="#top">d<\/a>/);
});
