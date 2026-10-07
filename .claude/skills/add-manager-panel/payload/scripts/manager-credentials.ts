/**
 * Provider credentials for the manager panel. Not meant to be run by hand (the panel starts it);
 * it can be, for debugging:
 *
 *   echo '{"value":"..."}' | pnpm exec tsx scripts/manager-credentials.ts save-claude
 *
 *   status              which credentials are stored
 *   save-claude         store an Anthropic API key or Claude subscription token (value on stdin)
 *   save-openai-key     store an OpenAI API key for OpenCode (value on stdin)
 *   chatgpt-login       start a ChatGPT device sign-in; prints the page and code, then waits
 *   remove <kind>       delete a stored credential: claude, openai-key or chatgpt-login
 *
 * Secrets are read from stdin only and are never printed. Output is one JSON event per line, see
 * src/modules/manager-panel/credentials-protocol.ts.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import {
  encodeEvent,
  findAnthropicSecret,
  findSecretByName,
  isCredentialKind,
  parseDeviceOutput,
  validSecret,
  type ScriptErrorCode,
  type ScriptEvent,
} from '../src/modules/manager-panel/credentials-protocol.js';
import { buildOpenCodeLoginArgs, createChatGptVault, readOpenCodeOAuth } from './opencode-auth.js';
import { apiKeyInjection, CHATGPT_SECRET, createOpenCodeVault } from './opencode-vault.js';

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

function emit(event: ScriptEvent): void {
  process.stdout.write(encodeEvent(event));
}

function fail(code: ScriptErrorCode): never {
  emit({ type: 'error', code });
  process.exit(1);
}

async function readSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let value: unknown;
  try {
    value = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value?: unknown }).value;
    // eslint-disable-next-line no-catch-all/no-catch-all -- anything unreadable is an invalid secret
  } catch {
    fail('invalid_secret');
  }
  if (!validSecret(value)) fail('invalid_secret');
  return value;
}

function onecli(args: string[], env = process.env): string {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  return execFileSync('onecli', args, {
    encoding: 'utf8',
    env: { ...env, PATH: `${localBin}${path.delimiter}${env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const OPENAI_KEY_NAME = 'OpenCode openai';
const openaiKeyVault = () =>
  createOpenCodeVault({ name: OPENAI_KEY_NAME, kind: 'api-key', host: 'api.openai.com', injection: apiKeyInjection('openai') });

async function status(): Promise<void> {
  let claude: boolean;
  try {
    claude = findAnthropicSecret(onecli(['secrets', 'list'])) !== null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreachable gateway is reported as a code
  } catch {
    return fail('gateway_unavailable');
  }
  try {
    const [openai, chatgpt] = await Promise.all([openaiKeyVault().find(), createChatGptVault().find()]);
    emit({ type: 'status', claude, openaiKey: openai !== null, chatgptLogin: chatgpt !== null });
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreachable gateway is reported as a code
  } catch {
    fail('gateway_unavailable');
  }
}

async function saveClaude(): Promise<void> {
  const value = await readSecret();
  try {
    const existing = findAnthropicSecret(onecli(['secrets', 'list']));
    if (existing?.id) {
      // Replacing keeps the secret's identity and the agents' access to it.
      onecli(['secrets', 'update', '--id', existing.id, '--value', value]);
    } else {
      // The value goes through a private file rather than the command line.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-claude-'));
      try {
        const file = path.join(dir, 'secret');
        fs.writeFileSync(file, value, { mode: 0o600 });
        onecli(['secrets', 'create', '--name', 'Anthropic', '--type', 'anthropic', '--file', file, '--host-pattern', 'api.anthropic.com']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    emit({ type: 'done' });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the gateway's message could contain the value; only a code leaves
  } catch {
    fail('save_failed');
  }
}

async function saveOpenAiKey(): Promise<void> {
  const value = await readSecret();
  try {
    const vault = openaiKeyVault();
    await vault.find();
    await vault.save(value);
    emit({ type: 'done' });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the gateway's message could contain the value; only a code leaves
  } catch {
    fail('save_failed');
  }
}

async function removeCredential(): Promise<void> {
  const kind = process.argv[3];
  if (!isCredentialKind(kind)) return fail('script_failed');
  try {
    const list = onecli(['secrets', 'list']);
    const found =
      kind === 'claude'
        ? findAnthropicSecret(list)
        : findSecretByName(list, kind === 'openai-key' ? OPENAI_KEY_NAME : CHATGPT_SECRET.name);
    // Already gone counts as removed.
    if (found?.id) onecli(['secrets', 'delete', '--id', found.id]);
    emit({ type: 'done' });
    // eslint-disable-next-line no-catch-all/no-catch-all -- only a code leaves
  } catch {
    fail('remove_failed');
  }
}

async function chatgptLogin(): Promise<void> {
  const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-chatgpt-login-'));
  fs.chmodSync(loginDir, 0o700);
  const containerName = `manager-chatgpt-login-${process.pid}`;
  const args = buildOpenCodeLoginArgs(loginDir, 'device', false);
  args.splice(1, 0, '--name', containerName);
  const stopContainer = (): void => {
    spawnSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], { stdio: 'ignore' });
  };
  let finished = false;
  const finish = (code?: ScriptErrorCode): never => {
    finished = true;
    stopContainer();
    fs.rmSync(loginDir, { recursive: true, force: true });
    if (code) emit({ type: 'error', code });
    return process.exit(code ? 1 : 0);
  };
  process.on('SIGTERM', () => finish('login_cancelled'));
  process.on('SIGINT', () => finish('login_cancelled'));

  const child = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => finish('runtime_unavailable'));
  let output = '';
  let prompted = false;
  child.stdout.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-8192);
    const found = !prompted ? parseDeviceOutput(output) : null;
    if (found) {
      prompted = true;
      emit({ type: 'prompt', url: found.url, code: found.code });
    }
  });
  const timer = setTimeout(() => finish('login_timeout'), LOGIN_TIMEOUT_MS);
  child.on('close', async (exitCode) => {
    clearTimeout(timer);
    if (finished) return;
    if (exitCode !== 0) return finish('login_failed');
    try {
      const authPath = path.join(loginDir, 'data', 'opencode', 'auth.json');
      const secret = readOpenCodeOAuth(JSON.parse(fs.readFileSync(authPath, 'utf8')));
      // The native token files are removed before the network call to the gateway.
      fs.rmSync(loginDir, { recursive: true, force: true });
      // save() replaces the entry find() observed, so the lookup comes first.
      const vault = createChatGptVault();
      await vault.find();
      await vault.save(secret);
      emit({ type: 'done' });
      finish();
      // eslint-disable-next-line no-catch-all/no-catch-all -- error text could contain token data; only a code leaves
    } catch {
      finish('save_failed');
    }
  });
}

const command = process.argv[2];
const handlers: Record<string, () => Promise<void>> = {
  status,
  'save-claude': saveClaude,
  'save-openai-key': saveOpenAiKey,
  'chatgpt-login': chatgptLogin,
  remove: removeCredential,
};
const handler = handlers[command ?? ''];
if (!handler) fail('script_failed');
handler().catch(() => fail('script_failed'));
