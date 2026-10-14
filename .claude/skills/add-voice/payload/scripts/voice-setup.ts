/**
 * Set up the voice channel for the NanoVoice app: the settings, the agent's instructions and the wiring.
 *
 *   pnpm exec tsx scripts/voice-setup.ts enable [--bind <address>] [--port <n>] [--folder <group folder>]
 *                                               [--dedicated] [--assistant-name <name>] [--rotate-token]
 *   pnpm exec tsx scripts/voice-setup.ts wire     (after the restart: connect the channel to the agent)
 *   pnpm exec tsx scripts/voice-setup.ts pair [--address <host>]   (what to enter in the app)
 *   pnpm exec tsx scripts/voice-setup.ts instructions [--folder <group folder>]
 *   pnpm exec tsx scripts/voice-setup.ts status
 *   pnpm exec tsx scripts/voice-setup.ts disable
 *
 * By default the app talks to an agent you already have (`--folder`, or the only one): same memory and tools as
 * your other channels, separate conversations. `--dedicated` makes a separate agent for the app, which cannot see
 * the others' memory or tools: the safer choice if the token could ever leak.
 *
 * Every command can be run again. Nothing is printed to a log except the token, and only by `pair` and by
 * `enable` when it makes a new one.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  SECTION_BEGIN,
  generateToken,
  mergeSection,
  pairingAddress,
  readEnvValue,
  readSettings,
  removeSection,
  upsertEnv,
  validBindHost,
  validToken,
} from '../src/channels/voice-install.js';

const root = process.cwd();
const envFile = path.join(root, '.env');
const sectionFile = path.join(root, 'src', 'channels', 'voice-instructions.md');
const DEDICATED_FOLDER = 'voice';

function fail(message: string): never {
  console.error(`voice-setup: ${message}`);
  process.exit(1);
}

function parse(argv: string[]): { command: string; flags: Map<string, string | true> } {
  const [command = 'status', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const withValue = new Set(['bind', 'port', 'folder', 'assistant-name', 'address']);
  const known = new Set([...withValue, 'dedicated', 'rotate-token']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) fail(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if (!known.has(name)) fail(`unknown option --${name}`);
    if (withValue.has(name)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
      flags.set(name, value);
    } else flags.set(name, true);
  }
  return { command, flags };
}

const readEnv = (): string => (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '');

function writePrivate(file: string, text: string): void {
  const temp = `${file}.voice-tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function groupFolders(): string[] {
  const dir = path.join(root, 'groups');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/** The group folder the voice agent uses: the one named, the dedicated one, or the only group there is. */
function chooseFolder(flags: Map<string, string | true>): string {
  if (flags.has('dedicated')) return DEDICATED_FOLDER;
  const named = flags.get('folder');
  if (typeof named === 'string') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(named)) fail('--folder is not a valid group folder name');
    return named;
  }
  const folders = groupFolders().filter((folder) => folder !== DEDICATED_FOLDER);
  if (folders.length === 1) return folders[0]!;
  fail(
    folders.length === 0
      ? 'no agent group exists yet: create your first agent, or use --dedicated'
      : `several agent groups exist (${folders.join(', ')}): say which one with --folder <name>, or use --dedicated`,
  );
}

function mergeInstructions(folder: string): string {
  if (!fs.existsSync(sectionFile)) fail(`${sectionFile} is missing; reinstall the add-voice skill`);
  const dir = path.join(root, 'groups', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'instructions.prepend.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const merged = mergeSection(existing, fs.readFileSync(sectionFile, 'utf8'));
  if (merged === existing) return 'already up to date';
  if (existing !== '') fs.copyFileSync(file, `${file}.before-voice`);
  fs.writeFileSync(file, merged);
  return existing === '' ? 'written' : `updated (the previous file is kept as ${path.basename(file)}.before-voice)`;
}

function enable(flags: Map<string, string | true>): void {
  const env = readEnv();
  const current = readSettings(env);
  const bind = typeof flags.get('bind') === 'string' ? (flags.get('bind') as string) : current.host;
  if (!validBindHost(bind)) fail('--bind is not a valid address');
  const port = typeof flags.get('port') === 'string' ? Number(flags.get('port')) : current.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be a whole number from 1024 to 65535');
  const folder = chooseFolder(flags);

  let token = readEnvValue(env, 'VOICE_AUTH_TOKEN') ?? '';
  const fresh = flags.has('rotate-token') || !validToken(token);
  if (fresh) token = generateToken();

  const updated = upsertEnv(env, {
    VOICE_ENABLED: 'true',
    VOICE_AUTH_TOKEN: token,
    VOICE_BIND_HOST: bind,
    VOICE_CHANNEL_PORT: String(port),
  });
  if (updated !== env) writePrivate(envFile, updated);
  console.log(`settings: ${fresh ? 'new token made' : 'token kept'}, listening on ${bind}:${port}`);
  console.log(`instructions for the agent in groups/${folder}: ${mergeInstructions(folder)}`);

  if (bind === '127.0.0.1' || bind === 'localhost')
    console.log('note: it listens on this machine only. For a phone, set --bind to a private network or VPN address.');
  if (bind === '0.0.0.0')
    console.log('warning: it listens on every address. Do not do this on a machine that faces the internet.');
  if (fresh) console.log(`\nToken (shown now; \`pair\` shows it again): ${token}`);
  console.log(
    `\nNext: restart NanoClaw, then \`pnpm exec tsx scripts/voice-setup.ts wire${flags.has('dedicated') ? ' --dedicated' : typeof flags.get('folder') === 'string' ? ` --folder ${folder}` : ''}\`.`,
  );
}

function run(command: string, args: string[], tolerate?: RegExp): void {
  if (!tolerate) {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed (exit ${result.status ?? 'signal'})`);
    return;
  }
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) return;
  if (tolerate.test(output)) return;
  process.stderr.write(output);
  fail(`\`${command} ${args.join(' ')}\` failed (exit ${result.status ?? 'signal'})`);
}

/** `ncl` is a script of the install (it talks to the running host), not a binary on the path. */
const ncl = (...args: string[]): string[] => ['exec', 'tsx', 'src/cli/client.ts', ...args];

async function wire(flags: Map<string, string | true>): Promise<void> {
  if (!readSettings(readEnv()).enabled)
    fail('the voice channel is not enabled: run `enable` first, then restart NanoClaw');
  const folder = chooseFolder(flags);
  // The name is only passed when it matters: registering rewrites the name in an existing group's instructions.
  const name = flags.get('assistant-name');
  const nameArgs =
    typeof name === 'string'
      ? ['--assistant-name', name]
      : flags.has('dedicated')
        ? ['--assistant-name', 'Assistant']
        : [];
  // Registering namespaces the platform id as `voice:default` and queues a welcome message, so it is done
  // only now, while the host runs the voice channel.
  run('pnpm', [
    'exec',
    'tsx',
    'setup/index.ts',
    '--step',
    'register',
    '--',
    '--platform-id',
    'default',
    '--name',
    'Voice',
    '--folder',
    folder,
    '--channel',
    'voice',
    '--session-mode',
    'shared',
    ...nameArgs,
  ]);
  run('pnpm', ncl('users', 'create', '--id', 'voice:default', '--kind', 'voice'), /already exists|UNIQUE|duplicate/i);
  await initDb(CENTRAL_DB_PATH);
  const group = await getAgentGroupByFolder(folder);
  if (!group)
    fail(
      `the agent group "${folder}" was not found after registering; add the member by hand: ncl members add --user voice:default --group <id>`,
    );
  run(
    'pnpm',
    ncl('members', 'add', '--user', 'voice:default', '--group', group.id),
    /already (a )?member|already exists|UNIQUE|duplicate/i,
  );
  console.log(`\nThe app is connected to the agent group "${folder}". Run \`pair\` to see what to enter in the app.`);
}

function pair(flags: Map<string, string | true>): void {
  const env = readEnv();
  const settings = readSettings(env);
  if (!settings.enabled || !settings.hasToken) fail('the voice channel is not set up: run `enable` first');
  const address = pairingAddress(
    settings,
    typeof flags.get('address') === 'string' ? (flags.get('address') as string) : undefined,
  );
  if ('problem' in address) fail(address.problem);
  console.log('In the NanoVoice app: Settings, NanoClaw server.');
  console.log(`  Address: ${address.url}`);
  console.log(`  Token:   ${readEnvValue(env, 'VOICE_AUTH_TOKEN')}`);
  console.log(
    'A plain ws:// address is accepted by the app only inside a VPN or private network; use wss:// behind a TLS proxy elsewhere.',
  );
}

function status(): void {
  const env = readEnv();
  const settings = readSettings(env);
  console.log(`enabled: ${settings.enabled}`);
  console.log(`listening on: ${settings.host}:${settings.port}`);
  console.log(`token set: ${settings.hasToken}`);
  for (const folder of groupFolders()) {
    const file = path.join(root, 'groups', folder, 'instructions.prepend.md');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(SECTION_BEGIN.slice(0, 20)))
      console.log(`voice instructions in: groups/${folder}`);
  }
}

function disable(): void {
  const env = readEnv();
  const updated = upsertEnv(env, { VOICE_ENABLED: 'false' });
  if (updated !== env) writePrivate(envFile, updated);
  for (const folder of groupFolders()) {
    const file = path.join(root, 'groups', folder, 'instructions.prepend.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const removed = removeSection(text);
    if (removed !== text) {
      fs.writeFileSync(file, removed);
      console.log(`voice instructions removed from groups/${folder}`);
    }
  }
  console.log(
    'The voice channel is off. Restart NanoClaw. The token and the wiring are kept; `enable` turns it back on.',
  );
}

const { command, flags } = parse(process.argv.slice(2));
switch (command) {
  case 'enable':
    enable(flags);
    break;
  case 'wire':
    await wire(flags);
    break;
  case 'pair':
    pair(flags);
    break;
  case 'instructions': {
    const folder = chooseFolder(flags);
    console.log(`instructions for the agent in groups/${folder}: ${mergeInstructions(folder)}`);
    break;
  }
  case 'status':
    status();
    break;
  case 'disable':
    disable();
    break;
  default:
    fail(`unknown command ${JSON.stringify(command)}; use enable, wire, pair, instructions, status or disable`);
}
