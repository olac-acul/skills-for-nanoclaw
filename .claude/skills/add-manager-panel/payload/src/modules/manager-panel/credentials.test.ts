import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CredentialError, createCredentialsPort, type SpawnScript } from './credentials.js';
import { encodeEvent, type ScriptEvent } from './credentials-protocol.js';

/** A stand-in for the child process: records what is written to stdin and lets the test script its output. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed: string | null = null;
  received = '';
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.received += chunk.toString('utf8');
    });
  }
  kill(signal?: string): boolean {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
  say(...events: ScriptEvent[]): void {
    for (const event of events) this.stdout.write(encodeEvent(event));
  }
  exit(code = 0): void {
    this.stdout.end();
    this.emit('close', code);
  }
}

let children: Array<{ command: string; child: FakeChild }>;
let spawnScript: SpawnScript;
let clock: number;

beforeEach(() => {
  children = [];
  clock = 1_000;
  spawnScript = (command) => {
    const child = new FakeChild();
    children.push({ command, child });
    return child as never;
  };
});
afterEach(() => undefined);

const port = (extra: Partial<Parameters<typeof createCredentialsPort>[0]> = {}) =>
  createCredentialsPort({ projectRoot: '/unused', spawnScript, now: () => clock, ...extra });

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('status', () => {
  it('reads the status event and caches it briefly', async () => {
    const credentials = port();
    const first = credentials.status();
    await tick();
    children[0].child.say({ type: 'status', claude: true, openaiKey: false, chatgptLogin: true });
    children[0].child.exit();
    expect(await first).toEqual({ claude: true, openaiKey: false, chatgptLogin: true });
    expect(await credentials.status()).toEqual({ claude: true, openaiKey: false, chatgptLogin: true });
    expect(children).toHaveLength(1);
    clock += 10_000;
    const again = credentials.status();
    await tick();
    children[1].child.say({ type: 'status', claude: false, openaiKey: false, chatgptLogin: false });
    children[1].child.exit();
    expect(await again).toEqual({ claude: false, openaiKey: false, chatgptLogin: false });
  });

  it('turns the script’s error code into an error', async () => {
    const pending = port().status();
    await tick();
    children[0].child.say({ type: 'error', code: 'gateway_unavailable' });
    children[0].child.exit(1);
    await expect(pending).rejects.toMatchObject({ code: 'gateway_unavailable' });
  });
});

describe('saving a credential', () => {
  const secret = 'sk-ant-oat01-' + 'z'.repeat(40);

  it('hands the secret to the script on stdin only, and nothing comes back', async () => {
    const credentials = port();
    const pending = credentials.saveClaude(secret);
    await tick();
    expect(children[0].command).toBe('save-claude');
    expect(JSON.parse(children[0].child.received)).toEqual({ value: secret });
    children[0].child.say({ type: 'done' });
    children[0].child.exit();
    await expect(pending).resolves.toBeUndefined();
  });

  it('uses the right command for an OpenAI key and reports a failed save without echoing anything', async () => {
    const credentials = port();
    const pending = credentials.saveOpenAiKey(secret);
    await tick();
    expect(children[0].command).toBe('save-openai-key');
    children[0].child.say({ type: 'error', code: 'save_failed' });
    children[0].child.exit(1);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).code).toBe('save_failed');
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String((error as Error).message)).not.toContain(secret);
  });

  it('treats an exit without a done event as a failure', async () => {
    const pending = port().saveClaude(secret);
    await tick();
    children[0].child.exit(0);
    await expect(pending).rejects.toMatchObject({ code: 'script_failed' });
  });

  it('gives up on a script that never answers', async () => {
    const pending = port({ callTimeoutMs: 20 }).saveClaude(secret);
    await expect(pending).rejects.toMatchObject({ code: 'script_failed' });
    expect(children[0].child.killed).toBe('SIGTERM');
  });
});

describe('ChatGPT sign-in', () => {
  it('goes from waiting for the code, to showing page and code, to done', async () => {
    const credentials = port();
    expect(credentials.loginState()).toEqual({ state: 'idle' });
    expect(credentials.startChatgptLogin()).toEqual({ state: 'waiting' });
    expect(children[0].command).toBe('chatgpt-login');
    children[0].child.say({ type: 'prompt', url: 'https://auth.example.test/device', code: 'AB-12' });
    await tick();
    expect(credentials.loginState()).toEqual({
      state: 'waiting',
      url: 'https://auth.example.test/device',
      code: 'AB-12',
    });
    expect(credentials.startChatgptLogin()).toMatchObject({ state: 'waiting', code: 'AB-12' }); // does not start a second one
    expect(children).toHaveLength(1);
    children[0].child.say({ type: 'done' });
    children[0].child.exit();
    await tick();
    expect(credentials.loginState()).toEqual({ state: 'done' });
  });

  it('can be cancelled, and reports a failed or abandoned sign-in', async () => {
    const credentials = port();
    credentials.startChatgptLogin();
    credentials.cancelChatgptLogin();
    expect(children[0].child.killed).toBe('SIGTERM');
    expect(credentials.loginState()).toEqual({ state: 'error', error: 'login_cancelled' });

    credentials.startChatgptLogin();
    children[1].child.say({ type: 'error', code: 'login_timeout' });
    children[1].child.exit(1);
    await tick();
    expect(credentials.loginState()).toEqual({ state: 'error', error: 'login_timeout' });

    credentials.startChatgptLogin();
    children[2].child.exit(1); // exits without saying anything
    await tick();
    expect(credentials.loginState()).toEqual({ state: 'error', error: 'login_failed' });
  });
});

describe('without the OpenCode and OneCLI skills', () => {
  it('reports that credentials are not available instead of failing obscurely', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cred-'));
    try {
      const credentials = createCredentialsPort({ projectRoot: dir });
      await expect(credentials.status()).rejects.toMatchObject({ code: 'script_missing' });
      await expect(credentials.saveClaude('x'.repeat(30))).rejects.toMatchObject({ code: 'script_missing' });
      expect(() => credentials.startChatgptLogin()).toThrowError(CredentialError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
