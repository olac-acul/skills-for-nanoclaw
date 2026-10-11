#!/usr/bin/env node
/**
 * Turn docs/guide.md into the page the panel serves at /guide.
 *
 *   node scripts/build-guide.mjs          write the generated module
 *   node scripts/build-guide.mjs --check  exit 1 if the generated module is out of date
 *
 * The source of truth is docs/guide.md. The generated file lives in the panel's payload, so the
 * guide installed with the panel is always the version that matches it.
 *
 * Only the Markdown the guide uses is supported: headings, paragraphs, bold/italic, inline code,
 * links, fenced code, block quotes, bullet and numbered lists (with indented continuation,
 * including code blocks), tables and rules. Everything is HTML-escaped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Link targets the guide may use; anything else (javascript:, data:, ...) is rendered as plain label text.
export const SAFE_LINK = /^(https?:|mailto:|\/|#)/i;
export const SOURCE = 'docs/guide.md';
export const TARGET = '.claude/skills/add-manager-panel/payload/src/modules/manager-panel/guide-html.ts';

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub-style anchor: lowercase, punctuation removed, spaces to dashes. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ +/g, '-');
}

function plain(text) {
  return text.replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/** Heading ids in document order, with the level and text. */
export function headings(markdown) {
  const out = [];
  const seen = new Map();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^(#{1,4})\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    const base = slugify(plain(match[2]));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push({ level: match[1].length, text: plain(match[2]), id: count ? `${base}-${count}` : base });
  }
  return out;
}

export function headingIds(markdown) {
  return headings(markdown).map((heading) => heading.id);
}

function inline(text) {
  const codes = [];
  let work = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  work = escapeHtml(work);
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    if (!SAFE_LINK.test(url)) return label;
    const external = /^https?:\/\//.test(url);
    return `<a href="${url}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });
  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  return work.replace(/\u0000(\d+)\u0000/g, (_m, index) => codes[Number(index)]);
}

const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function renderBlocks(lines, ids) {
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^(\s*)```\s*(\S*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i].startsWith(fence[1]) ? lines[i].slice(fence[1].length) : lines[i]);
        i++;
      }
      i++;
      html.push(`<pre><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = ids.shift();
      html.push(`<h${level} id="${id}">${inline(heading[2])}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (/^>/.test(line)) {
      const body = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderBlocks(body, [])}</blockquote>`);
      continue;
    }
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (row) => row.replace(/^\||\|\s*$/g, '').split('|').map((cell) => cell.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const hasHead = head.some(Boolean);
      html.push(
        `<div class="table-wrap"><table>${hasHead ? `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${rows
          .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const indent = item[1].length;
      const items = [];
      while (i < lines.length) {
        // Blank lines between two items of the same list do not end it.
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        const start = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
        if (!start || start[1].length !== indent || /\d/.test(start[2]) !== ordered) break;
        i = j;
        const body = [start[3]];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          const isBlank = next.trim() === '';
          const sibling = LIST_ITEM.exec(next);
          if (sibling && sibling[1].length <= indent) break;
          if (isBlank) {
            // A blank line continues the item only when the next non-blank line is indented under it.
            let j = i;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length && new RegExp(`^ {${indent + 2},}\\S`).test(lines[j])) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          if (!new RegExp(`^ {${indent + 2},}`).test(next)) break;
          body.push(next.slice(Math.min(indent + 3, next.length - next.trimStart().length)));
          i++;
        }
        items.push(body);
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((body) => `<li>${renderBlocks(body, []).replace(/^<p>([\s\S]*?)<\/p>/, '$1')}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\s|```|>|\||---+\s*$)/.test(lines[i]) && !LIST_ITEM.test(lines[i])) paragraph.push(lines[i++].trim());
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return html.join('\n');
}

export function renderMarkdown(markdown) {
  // HTML comments are authoring notes (for example privacy-scan markers), not content.
  const visible = markdown.replace(/ ?<!--[\s\S]*?-->/g, '');
  return renderBlocks(visible.split('\n'), headingIds(visible));
}

export function renderPage(markdown) {
  const toc = headings(markdown)
    .filter((heading) => heading.level === 2 || heading.level === 3)
    .map((heading) => `<a class="toc-${heading.level}" href="#${heading.id}">${escapeHtml(heading.text)}</a>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#1f6feb">
<meta name="color-scheme" content="light dark">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>Manager guide</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="guide-page">
<header class="guide-top"><strong>NanoClaw Manager</strong><span class="muted">Guide</span><a class="back" href="/">&larr; Back to the panel</a></header>
<div class="guide-wrap">
<nav class="guide-toc" aria-label="Contents">
${toc}
</nav>
<main class="guide">
${renderMarkdown(markdown)}
</main>
</div>
</body>
</html>
`;
}

export function generatedModule(markdown) {
  return `/**
 * GENERATED from docs/guide.md by scripts/build-guide.mjs. Do not edit by hand.
 * The page the panel serves at /guide.
 */
// prettier-ignore
export const GUIDE_HTML: string = ${JSON.stringify(renderPage(markdown))}; // privacy-scan: allow -- generated; docs/guide.md carries its own markers
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = generatedModule(readFileSync(SOURCE, 'utf8'));
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      // missing counts as out of date
    }
    if (current !== expected) {
      console.error(`${TARGET} is out of date; run: node scripts/build-guide.mjs`);
      process.exit(1);
    }
    console.log('guide: up to date');
  } else {
    writeFileSync(TARGET, expected);
    console.log(`guide: wrote ${TARGET}`);
  }
}
