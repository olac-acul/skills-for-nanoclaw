/**
 * Provider credentials, as the panel sees them: what is stored, store a key or token, sign in to
 * ChatGPT. The work is done by `scripts/manager-credentials.ts` in a child process (see
 * credentials-protocol.ts); this file starts it, feeds it a secret on stdin and turns its events
 * into results. A secret is held in memory only for the length of one call.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { parseEvents, type CredentialKind, type ScriptErrorCode, type ScriptEvent } from './credentials-protocol.js';

export interface CredentialStatus {
  claude: boolean;
  openaiKey: boolean;
  chatgptLogin: boolean;
}

export interface LoginState {
  state: 'idle' | 'waiting' | 'done' | 'error';
  /** The page to open and the code to enter there, once the sign-in has started. */
  url?: string;
  code?: string;
  error?: ScriptErrorCode;
}

export class CredentialError extends Error {
  constructor(readonly code: ScriptErrorCode) {
    super(code);
    this.name = 'CredentialError';
  }
}

export interface CredentialsPort {
  status(): Promise<CredentialStatus>;
  saveClaude(value: string): Promise<void>;
  saveOpenAiKey(value: string): Promise<void>;
  /** Delete a stored credential from the gateway; removing one that is not there is not an error. */
  removeCredential(kind: CredentialKind): Promise<void>;
  startChatgptLogin(): LoginState;
  loginState(): LoginState;
  cancelChatgptLogin(): void;
}

const LOGIN_PREFIX = 'manager-chatgpt-login-';
/** The login helper gives up after 15 minutes; anything older than this is left over from a crash. */
const STALE_LOGIN_MS = 20 * 60 * 1000;

export interface SweepDeps {
  tmpDir: string;
  now: number;
  listContainers(): string[];
  removeContainer(name: string): void;
  isProcessAlive(pid: number): boolean;
}

/**
 * Remove what a killed login helper left behind: its 0700 directory (it may hold OAuth tokens) and its
 * container. Matches only the exact names the helper creates, never throws.
 */
export function sweepStaleLogins(deps: SweepDeps): void {
  try {
    for (const entry of fs.readdirSync(deps.tmpDir)) {
      if (!/^manager-chatgpt-login-[A-Za-z0-9]{6}$/.test(entry)) continue;
      try {
        const dir = path.join(deps.tmpDir, entry);
        const stat = fs.lstatSync(dir);
        const mine = typeof process.getuid !== 'function' || stat.uid === process.getuid();
        if (stat.isDirectory() && mine && deps.now - stat.mtimeMs > STALE_LOGIN_MS) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup is best effort
      } catch {
        // Best effort: the next sweep tries again.
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup is best effort
  } catch {
    // No temp directory to read.
  }
  try {
    for (const name of deps.listContainers()) {
      const match = /^manager-chatgpt-login-(\d{1,10})$/.exec(name);
      if (match && !deps.isProcessAlive(Number(match[1]))) deps.removeContainer(name);
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup is best effort
  } catch {
    // No container runtime, or it is not running.
  }
}

function liveSweepDeps(): SweepDeps {
  return {
    tmpDir: os.tmpdir(),
    now: Date.now(),
    listContainers: () => {
      const result = spawnSync(
        CONTAINER_RUNTIME_BIN,
        ['ps', '-a', '--filter', `name=${LOGIN_PREFIX}`, '--format', '{{.Names}}'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
        },
      );
      return result.status === 0 ? result.stdout.split('\n').map((line) => line.trim()) : [];
    },
    removeContainer: (name) => {
      spawnSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 });
    },
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
  };
}

export type SpawnScript = (command: string, argument?: string) => ChildProcess;

export interface CredentialsOptions {
  projectRoot: string;
  /** Replace how the script is started (tests). */
  spawnScript?: SpawnScript;
  statusTtlMs?: number;
  callTimeoutMs?: number;
  now?: () => number;
  /** Clean up after a login helper that was killed; defaults to the real sweep unless `spawnScript` is replaced. */
  sweep?: () => void;
}

export function createCredentialsPort(options: CredentialsOptions): CredentialsPort {
  const now = options.now ?? Date.now;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const statusTtlMs = options.statusTtlMs ?? 3_000;
  const start: SpawnScript =
    options.spawnScript ??
    ((command, argument) =>
      spawn(
        path.join(options.projectRoot, 'node_modules', '.bin', 'tsx'),
        ['scripts/manager-credentials.ts', command, ...(argument ? [argument] : [])],
        {
          cwd: options.projectRoot,
          stdio: ['pipe', 'pipe', 'ignore'],
        },
      ));

  let swept = false;
  const sweepOnce = (): void => {
    if (swept) return;
    swept = true;
    const sweep = options.sweep ?? (options.spawnScript ? undefined : () => sweepStaleLogins(liveSweepDeps()));
    try {
      sweep?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup must never break the caller
    } catch {
      // Ignored.
    }
  };

  let cached: { at: number; value: CredentialStatus } | null = null;
  let login: { child: ChildProcess; state: LoginState } | null = null;

  /** Run one command to completion and return its events. */
  function run(command: string, secret?: string, argument?: string): Promise<ScriptEvent[]> {
    return new Promise((resolve, reject) => {
      const child = start(command, argument);
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new CredentialError('script_failed'));
      }, callTimeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new CredentialError('script_failed'));
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve(parseEvents(stdout));
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(secret === undefined ? '' : JSON.stringify({ value: secret }));
    });
  }

  /** The script needs `add-opencode` and `add-onecli`; without them credentials simply are not offered. */
  const scriptPresent = (): boolean =>
    options.spawnScript !== undefined ||
    fs.existsSync(path.join(options.projectRoot, 'scripts', 'manager-credentials.ts'));
  const requireScript = (): void => {
    if (!scriptPresent()) throw new CredentialError('script_missing');
  };

  function failure(events: ScriptEvent[]): CredentialError | null {
    const error = events.find((event) => event.type === 'error');
    if (error && error.type === 'error') return new CredentialError(error.code);
    return events.some((event) => event.type === 'done') ? null : new CredentialError('script_failed');
  }

  async function save(command: string, value: string): Promise<void> {
    requireScript();
    const problem = failure(await run(command, value));
    cached = null;
    if (problem) throw problem;
  }

  function applyEvent(event: ScriptEvent, state: LoginState): LoginState {
    if (event.type === 'prompt') return { ...state, state: 'waiting', url: event.url, code: event.code };
    if (event.type === 'done') return { state: 'done' };
    if (event.type === 'error') return { state: 'error', error: event.code };
    return state;
  }

  return {
    async status() {
      requireScript();
      sweepOnce();
      if (cached && now() - cached.at < statusTtlMs) return cached.value;
      const events = await run('status');
      const status = events.find((event) => event.type === 'status');
      if (!status || status.type !== 'status') throw failure(events) ?? new CredentialError('script_failed');
      const value = { claude: status.claude, openaiKey: status.openaiKey, chatgptLogin: status.chatgptLogin };
      cached = { at: now(), value };
      return value;
    },
    saveClaude: (value) => save('save-claude', value),
    saveOpenAiKey: (value) => save('save-openai-key', value),
    async removeCredential(kind) {
      requireScript();
      const problem = failure(await run('remove', undefined, kind));
      cached = null;
      if (problem) throw problem;
    },
    startChatgptLogin() {
      requireScript();
      sweepOnce();
      if (login && login.state.state === 'waiting') return login.state;
      const child = start('chatgpt-login');
      const entry = { child, state: { state: 'waiting' } as LoginState };
      login = entry;
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (const event of parseEvents(buffer)) entry.state = applyEvent(event, entry.state);
      });
      child.once('error', () => {
        entry.state = { state: 'error', error: 'script_failed' };
      });
      child.once('close', () => {
        cached = null;
        if (entry.state.state === 'waiting') entry.state = { state: 'error', error: 'login_failed' };
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end('');
      return entry.state;
    },
    loginState: () => login?.state ?? { state: 'idle' },
    cancelChatgptLogin() {
      if (login && login.state.state === 'waiting') {
        login.child.kill('SIGTERM');
        login.state = { state: 'error', error: 'login_cancelled' };
      }
    },
  };
}
