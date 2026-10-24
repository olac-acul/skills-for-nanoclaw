/**
 * Local administration of the manager panel.
 *
 *   pnpm exec tsx scripts/manager-panel.ts setup-code      first-run code for the sign-up form
 *   pnpm exec tsx scripts/manager-panel.ts reset-password  set a new password (signs everyone out)
 *   pnpm exec tsx scripts/manager-panel.ts revoke-sessions sign every browser out
 *   pnpm exec tsx scripts/manager-panel.ts unlock          clear the login lock after too many failures
 *   pnpm exec tsx scripts/manager-panel.ts status
 *
 * Whoever can run this has the same access as the NanoClaw user, so it is the
 * recovery path for a forgotten password.
 */
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { PANEL_ENV_KEYS, parsePanelConfig } from '../src/modules/manager-panel/config.js';
import {
  SETUP_LIFETIME_MS,
  generateSetupCode,
  hashPassword,
  passwordProblem,
} from '../src/modules/manager-panel/password.js';
import { readHidden } from '../src/modules/manager-backup/terminal.js';
import { PanelState } from '../src/modules/manager-panel/state.js';

function fail(message: string): never {
  console.error(`manager-panel: ${message}`);
  process.exit(1);
}

async function readSecret(question: string): Promise<string> {
  return (await readHidden(question)) ?? fail('a password can only be entered at an interactive terminal');
}

async function main(): Promise<void> {
  const state = new PanelState(path.join(DATA_DIR, 'manager-panel'));
  const fromFile = readEnvFile([...PANEL_ENV_KEYS]);
  const config = parsePanelConfig(
    Object.fromEntries(PANEL_ENV_KEYS.map((key) => [key, process.env[key] ?? fromFile[key]])),
    'cli',
  );
  const origin =
    config.publicOrigin ??
    `${config.tlsCertFile ? 'https' : 'http'}://${config.bind === '0.0.0.0' ? '<this-machine>' : config.bind}:${config.port}`;

  switch (process.argv[2]) {
    case 'setup-code': {
      if (state.admin()) fail('an administrator already exists; use reset-password to change the password');
      const record = state.ensureSetupCode(new Date(), generateSetupCode, SETUP_LIFETIME_MS);
      console.log(
        `Open ${origin} and create the administrator account with this code:\n\n  ${record.code}\n\nIt works once and expires at ${record.expires_at}.`,
      );
      return;
    }
    case 'reset-password': {
      const first = await readSecret('New password (at least 12 characters): ');
      const problem = passwordProblem(first);
      if (problem) fail(`the password is ${problem === 'too_short' ? 'too short' : 'too long'}`);
      if ((await readSecret('Repeat the password: ')) !== first) fail('the two entries differ');
      state.setPassword(await hashPassword(first), new Date());
      state.setThrottle({ failures: 0, locked_until: null });
      console.log('Password changed; every browser was signed out.');
      return;
    }
    case 'revoke-sessions':
      state.revokeSessions(new Date());
      console.log('Every browser was signed out.');
      return;
    case 'unlock':
      state.setThrottle({ failures: 0, locked_until: null });
      console.log('Login lock cleared.');
      return;
    case 'status': {
      const throttle = state.throttle();
      console.log(`Enabled:        ${config.enabled}`);
      console.log(`Address:        ${origin}`);
      console.log(`Administrator:  ${state.admin() ? 'set up' : 'not set up yet (run setup-code)'}`);
      console.log(
        `Failed logins:  ${throttle.failures}${throttle.locked_until ? ` (locked until ${throttle.locked_until})` : ''}`,
      );
      console.log(`Backups folder: ${config.backupDir}`);
      return;
    }
    default:
      fail('usage: setup-code | reset-password | revoke-sessions | unlock | status');
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
