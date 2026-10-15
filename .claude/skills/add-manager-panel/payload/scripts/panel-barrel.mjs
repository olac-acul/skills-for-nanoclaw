#!/usr/bin/env node
/**
 * Puts the manager panel's one import line in the host's module list (`src/modules/index.ts`), in the right place.
 *
 * The line goes BEFORE upstream's `community-portal` import when there is one, not at the end: a test of upstream's
 * (community-portal/registration.test.ts) takes the last host-start hook of that list to be the portal's own, so a
 * module added after it turns that test red. Without the portal import (an older NanoClaw) the line goes at the end.
 * Running it again changes nothing, and it moves a line that an earlier install left at the end.
 *
 *   node scripts/panel-barrel.mjs            put the line in place
 *   node scripts/panel-barrel.mjs --check    report only; exit 1 when it is not in place
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PANEL_IMPORT = "import './manager-panel/index.js';";
export const PORTAL_IMPORT = "import './community-portal/index.js';";

/** The barrel's text with the panel's import in place. */
export function withPanelImport(text) {
  const lines = text.split('\n');
  const rest = lines.filter((line) => line.trim() !== PANEL_IMPORT);
  const portal = rest.findIndex((line) => line.trim() === PORTAL_IMPORT);
  if (portal >= 0) rest.splice(portal, 0, PANEL_IMPORT);
  else {
    while (rest.length > 0 && rest[rest.length - 1] === '') rest.pop();
    rest.push(PANEL_IMPORT, '');
  }
  return rest.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.join(process.cwd(), 'src', 'modules', 'index.ts');
  if (!fs.existsSync(file)) {
    console.error('panel barrel: src/modules/index.ts not found (is this a NanoClaw install?)');
    process.exit(2);
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = withPanelImport(before);
  if (process.argv.includes('--check')) {
    console.log(after === before ? 'panel barrel: in place' : 'panel barrel: not in place');
    process.exit(after === before ? 0 : 1);
  }
  if (after === before) console.log('panel barrel: already in place');
  else {
    fs.writeFileSync(`${file}.tmp`, after);
    fs.renameSync(`${file}.tmp`, file);
    console.log('panel barrel: import placed in src/modules/index.ts');
  }
}
