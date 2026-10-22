#!/usr/bin/env node
/**
 * Two anchored edits in the OpenCode provider's configuration (`opencode-config.ts`), which no skill directive can
 * express as a copy or an append. Where the configuration is handed to OpenCode's server (`buildOpenCodeServerEnv`)
 * it goes through `asAssistant()`:
 *
 *   prompt          OpenCode's build agent gets the assistant prompt instead of OpenCode's own coding prompt;
 *   coding tools    the permission policy denies `task` and `todowrite`, so OpenCode leaves them out of every prompt.
 *
 * The configuration the provider builds is not changed, so upstream's tests of it still hold. The file exists only
 * where the OpenCode provider is installed; without it there is nothing to do (not an error).
 *
 * Built like the voice skill's seams, to fail loudly rather than guess:
 *
 *   - an edit is applied only when its anchor text occurs exactly once;
 *   - an edit already in place (its marker is present) is left alone, so running it again changes nothing;
 *   - if any edit cannot be placed (upstream changed that code), nothing is written and the script exits with a
 *     message naming the edit.
 *
 *   node scripts/assistant-prompt-seams.mjs          apply (default)
 *   node scripts/assistant-prompt-seams.mjs --check  report only; exit 1 when an edit is missing or cannot be placed
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Each edit: `anchor` (exact text, once in the file), `replace` (the text that takes its place) and `marker`
 *  (text that is present only once the edit is applied). A file marked `optional` is left alone when it is absent. */
export const SEAMS = [
  {
    file: 'container/agent-runner/src/providers/opencode-config.ts',
    optional: true,
    edits: [
      {
        name: 'import asAssistant',
        anchor: "import { openCodeInstructionsPath } from './opencode-memory.js';\n",
        replace:
          "import { openCodeInstructionsPath } from './opencode-memory.js';\nimport { asAssistant } from '../assistant-prompt.js';\n",
        marker: "import { asAssistant } from '../assistant-prompt.js';",
      },
      {
        name: "the server's configuration as an assistant",
        anchor: '    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),\n',
        replace: '    OPENCODE_CONFIG_CONTENT: JSON.stringify(asAssistant(config)),\n',
        marker: 'JSON.stringify(asAssistant(config))',
      },
    ],
  },
];

const count = (text, needle) => (needle === '' ? 0 : text.split(needle).length - 1);

/**
 * Work out every file's new content without writing anything.
 * Returns `{ files: [{file, content, changed}], problems: [string] }`.
 */
export function plan(root, seams = SEAMS) {
  const files = [];
  const problems = [];
  for (const { file, edits, optional } of seams) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      if (!optional) problems.push(`${file}: file not found (is this a NanoClaw install?)`);
      continue;
    }
    let content = fs.readFileSync(full, 'utf8');
    let changed = false;
    for (const edit of edits) {
      if (content.includes(edit.marker)) continue; // already in place
      const found = count(content, edit.anchor);
      if (found !== 1) {
        problems.push(
          `${file}: cannot place "${edit.name}": its anchor text occurs ${found} time(s), expected exactly 1. ` +
            'Upstream changed this code; the edit must be reviewed by hand.',
        );
        continue;
      }
      content = content.replace(edit.anchor, () => edit.replace);
      changed = true;
    }
    files.push({ file, content, changed });
  }
  return { files, problems };
}

/** Apply every edit, or none. Returns the files written. */
export function apply(root, seams = SEAMS) {
  const { files, problems } = plan(root, seams);
  if (problems.length > 0) {
    const error = new Error(problems.join('\n'));
    error.problems = problems;
    throw error;
  }
  const written = [];
  for (const { file, content, changed } of files) {
    if (!changed) continue;
    const full = path.join(root, file);
    const temp = `${full}.seams-tmp`;
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, full);
    written.push(file);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const checkOnly = process.argv.includes('--check');
  try {
    if (checkOnly) {
      const { files, problems } = plan(root);
      if (problems.length > 0) throw Object.assign(new Error(problems.join('\n')), { problems });
      const missing = files.filter((f) => f.changed).map((f) => f.file);
      if (missing.length > 0) {
        console.log(`assistant prompt seams: not applied yet in ${missing.join(', ')}`);
        process.exit(1);
      }
      console.log('assistant prompt seams: all in place');
    } else {
      const written = apply(root);
      console.log(written.length > 0 ? `assistant prompt seams: applied to ${written.join(', ')}` : 'assistant prompt seams: already in place');
    }
  } catch (error) {
    console.error('assistant prompt seams: NOTHING WAS CHANGED.\n' + error.message);
    console.error(
      '\nThe NanoClaw code these edits attach to has changed. Update this skill (or open an issue) rather than editing by hand.',
    );
    process.exit(2);
  }
}
