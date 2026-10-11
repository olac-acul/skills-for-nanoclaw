import { beforeEach, describe, expect, it } from 'vitest';

import type { ProbeResult } from './model-endpoint.js';
import {
  ModelSettingsError,
  applyProviderChange,
  detectProvider,
  previewProviderChange,
  applyModelChange,
  outputLimitFor,
  previewModelChange,
  readModelStatus,
  recoverModelChange,
  type GroupModel,
  type Journal,
  type ModelPorts,
} from './model-settings.js';

const GOOD: ProbeResult = { reason: null, models: ['m1', 'm2'], contextLimit: 32768, local: true };

interface Fake extends ModelPorts {
  env: Record<string, string | null>;
  groups: GroupModel[];
  journal: Journal | null;
  restarts: string[];
  failOn: { setGroup?: string; restart?: string; updateEnvOnce?: boolean };
  probeResult: ProbeResult;
  creds: { claude: boolean; openaiKey: boolean; chatgptLogin: boolean };
}

function fake(): Fake {
  const self: Fake = {
    env: {
      OPENCODE_PROVIDER: 'openrouter',
      OPENCODE_MODEL: 'openrouter/old',
      OPENCODE_BASE_URL: null,
      OPENCODE_AUTH_MODE: 'chatgpt',
    },
    groups: [
      { id: 'g1', provider: 'claude', model: null },
      { id: 'g2', provider: 'opencode', model: 'openrouter/old' },
    ],
    journal: null,
    restarts: [],
    failOn: {},
    probeResult: GOOD,
    creds: { claude: false, openaiKey: false, chatgptLogin: false },
    readEnv: (keys) => Object.fromEntries(keys.map((key) => [key, self.env[key] ?? null])),
    updateEnv(changes) {
      if (self.failOn.updateEnvOnce) {
        self.failOn.updateEnvOnce = false;
        throw new Error('disk full');
      }
      const before = Object.fromEntries(Object.keys(changes).map((key) => [key, self.env[key] ?? null]));
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete self.env[key];
        else self.env[key] = value;
      }
      return before;
    },
    listGroups: async () => self.groups.map((group) => ({ ...group })),
    async setGroup(id, value) {
      if (self.failOn.setGroup === id) {
        self.failOn.setGroup = undefined;
        throw new Error('db locked');
      }
      const group = self.groups.find((entry) => entry.id === id)!;
      group.provider = value.provider;
      group.model = value.model;
    },
    async restartGroup(id) {
      if (self.failOn.restart === id) throw new Error('docker unavailable');
      self.restarts.push(id);
    },
    probe: async () => self.probeResult,
    credentials: async () => self.creds,
    readJournal: () => self.journal,
    writeJournal: (journal) => {
      self.journal = journal;
    },
    clearJournal: () => {
      self.journal = null;
    },
  };
  return self;
}

let ports: Fake;
beforeEach(() => {
  ports = fake();
});

const input = { baseUrl: 'http://models.test:8000/v1/', model: 'qwen3-coder' };

describe('previewModelChange', () => {
  it('reports the probe and how many groups would be touched, changing nothing', async () => {
    const before = JSON.stringify([ports.env, ports.groups]);
    const preview = await previewModelChange(ports, input);
    expect(preview).toMatchObject({ groupsAffected: 2, restartsNeeded: 2, probe: { reason: null } });
    expect(JSON.stringify([ports.env, ports.groups])).toBe(before);
    expect(ports.journal).toBeNull();
  });

  it('rejects malformed model ids before any network call', async () => {
    await expect(previewModelChange(ports, { ...input, model: 'bad id; rm' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('applyModelChange', () => {
  it('points every group and the install defaults at the endpoint, restarts them and clears the journal', async () => {
    ports.probeResult = { ...GOOD, models: ['qwen3-coder', 'tiny'] };
    const outcome = await applyModelChange(ports, { ...input, smallModel: 'tiny' });
    expect(outcome).toEqual({ groups: 2, restarted: 2, restartFailures: [] });
    expect(ports.env).toMatchObject({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'http://models.test:8000/v1',
      OPENCODE_MODEL: 'openai/qwen3-coder',
      OPENCODE_SMALL_MODEL: 'openai/tiny',
      OPENCODE_MODEL_CONTEXT_LIMIT: '32768',
      OPENCODE_MODEL_OUTPUT_LIMIT: '4096', // OpenCode rejects a context limit without an output limit
    });
    expect(ports.env.OPENCODE_AUTH_MODE).toBeUndefined();
    expect(ports.groups.every((group) => group.provider === 'opencode' && group.model === 'openai/qwen3-coder')).toBe(
      true,
    );
    expect(ports.restarts).toEqual(['g1', 'g2']);
    expect(ports.journal).toBeNull();
  });

  it('refuses when the endpoint fails its checks, touching nothing', async () => {
    ports.probeResult = { reason: 'model_not_found', models: ['other'], contextLimit: null, local: true };
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({
      code: 'probe_failed',
      detail: 'model_not_found',
    });
    expect(ports.env.OPENCODE_PROVIDER).toBe('openrouter');
    expect(ports.journal).toBeNull();
    expect(ports.restarts).toEqual([]);
  });

  it('rolls everything back when a group cannot be updated', async () => {
    ports.failOn.setGroup = 'g2';
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({ code: 'apply_failed_rolled_back' });
    expect(ports.env).toMatchObject({
      OPENCODE_PROVIDER: 'openrouter',
      OPENCODE_MODEL: 'openrouter/old',
      OPENCODE_AUTH_MODE: 'chatgpt',
    });
    expect(ports.env.OPENCODE_BASE_URL).toBeUndefined();
    expect(ports.groups).toEqual([
      { id: 'g1', provider: 'claude', model: null },
      { id: 'g2', provider: 'opencode', model: 'openrouter/old' },
    ]);
    expect(ports.journal).toBeNull();
    expect(ports.restarts).toEqual(['g1', 'g2']); // restarted onto the restored settings
  });

  it('keeps the change when only a restart fails, and reports it', async () => {
    ports.failOn.restart = 'g2';
    const outcome = await applyModelChange(ports, input);
    expect(outcome).toEqual({ groups: 2, restarted: 1, restartFailures: ['g2'] });
    expect(ports.env.OPENCODE_MODEL).toBe('openai/qwen3-coder');
    expect(ports.journal).toBeNull();
  });

  it('keeps the journal and says so when the rollback itself cannot finish', async () => {
    ports.failOn.setGroup = 'g2';
    let calls = 0;
    const original = ports.setGroup;
    ports.setGroup = async (id, value) => {
      calls++;
      if (calls > 2) throw new Error('db gone'); // the rollback writes also fail
      return original(id, value);
    };
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({ code: 'apply_failed_rollback_incomplete' });
    expect(ports.journal).not.toBeNull();
  });

  it('refuses to start while an earlier change is unrecovered', async () => {
    ports.journal = { startedAt: 't', env: {}, groups: [] };
    await expect(applyModelChange(ports, input)).rejects.toBeInstanceOf(ModelSettingsError);
    expect((await readModelStatus(ports)).interrupted).toBe(true);
  });
});

describe('recoverModelChange', () => {
  it('rolls an interrupted change back at startup', async () => {
    ports.failOn.restart = 'nope';
    const original = ports.groups.map((group) => ({ ...group }));
    // Simulate a crash after the first writes: journal present, state half changed.
    ports.journal = {
      startedAt: 't',
      env: ports.readEnv(['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_AUTH_MODE']),
      groups: original,
    };
    ports.env.OPENCODE_PROVIDER = 'openai';
    ports.env.OPENCODE_MODEL = 'openai/qwen3-coder';
    ports.groups[0].provider = 'opencode';
    expect(await recoverModelChange(ports)).toBe('rolled-back');
    expect(ports.env.OPENCODE_PROVIDER).toBe('openrouter');
    expect(ports.groups).toEqual(original);
    expect(ports.journal).toBeNull();
    expect(await recoverModelChange(ports)).toBe('none');
  });
});

describe('small model', () => {
  const small = { ...input, smallModel: 'tiny' };

  it('is checked against the endpoint list in the preview and refused on apply when missing', async () => {
    ports.probeResult = { ...GOOD, models: ['qwen3-coder', 'other'] };
    expect((await previewModelChange(ports, small)).smallModel).toBe('not_found');
    await expect(applyModelChange(ports, small)).rejects.toMatchObject({
      code: 'probe_failed',
      detail: 'small_model_not_found',
    });
    expect(ports.journal).toBeNull();
    expect(ports.env.OPENCODE_PROVIDER).toBe('openrouter');
  });

  it('passes when listed, when equal to the main model, or when none is given', async () => {
    ports.probeResult = { ...GOOD, models: ['qwen3-coder', 'tiny'] };
    expect((await previewModelChange(ports, small)).smallModel).toBe('listed');
    expect((await previewModelChange(ports, { ...input, smallModel: 'qwen3-coder' })).smallModel).toBe('same');
    expect((await previewModelChange(ports, input)).smallModel).toBe('same');
    await expect(applyModelChange(ports, small)).resolves.toMatchObject({ groups: 2 });
    expect(ports.env.OPENCODE_SMALL_MODEL).toBe('openai/tiny');
  });

  it('is not judged when the endpoint list may be truncated', async () => {
    ports.probeResult = { ...GOOD, models: Array.from({ length: 200 }, (_, index) => `m${index}`) };
    expect((await previewModelChange(ports, small)).smallModel).toBe('unchecked');
  });
});

describe('output limit', () => {
  it('is half the window, between 256 and 4096', () => {
    expect(outputLimitFor(32768)).toBe(4096);
    expect(outputLimitFor(4096)).toBe(2048);
    expect(outputLimitFor(300)).toBe(256);
  });

  it('is written and removed together with the context limit', async () => {
    await applyModelChange(ports, input);
    expect(ports.env.OPENCODE_MODEL_OUTPUT_LIMIT).toBe('4096');
    ports.probeResult = { ...GOOD, contextLimit: null };
    await applyModelChange(ports, input);
    expect(ports.env.OPENCODE_MODEL_CONTEXT_LIMIT).toBeUndefined();
    expect(ports.env.OPENCODE_MODEL_OUTPUT_LIMIT).toBeUndefined();
  });
});

describe('readModelStatus', () => {
  it('marks groups that do not follow the install settings', async () => {
    ports.env.OPENCODE_MODEL = 'openrouter/old';
    const status = await readModelStatus(ports);
    expect(status.groups).toEqual([
      { id: 'g1', provider: 'claude', model: null, followsSettings: false },
      { id: 'g2', provider: 'opencode', model: 'openrouter/old', followsSettings: true },
    ]);
  });
});

describe('providers other than an endpoint', () => {
  it('switches every agent to Claude (the default provider) with an optional model, once a credential is stored', async () => {
    await expect(applyProviderChange(ports, { kind: 'claude', model: 'claude-test-model' })).rejects.toMatchObject({
      code: 'probe_failed',
      detail: 'credential_missing',
    });
    expect(ports.groups[0]).toEqual({ id: 'g1', provider: 'claude', model: null });
    expect(ports.journal).toBeNull();

    ports.creds.claude = true;
    const envBefore = JSON.stringify(ports.env);
    const outcome = await applyProviderChange(ports, { kind: 'claude', model: 'claude-test-model' });
    expect(outcome).toEqual({ groups: 2, restarted: 2, restartFailures: [] });
    expect(ports.groups).toEqual([
      { id: 'g1', provider: null, model: 'claude-test-model' },
      { id: 'g2', provider: null, model: 'claude-test-model' },
    ]);
    expect(JSON.stringify(ports.env)).toBe(envBefore); // OPENCODE_* untouched
    await applyProviderChange(ports, { kind: 'claude' });
    expect(ports.groups.every((g) => g.provider === null && g.model === null)).toBe(true);
  });

  it('sets up ChatGPT with a subscription login: native endpoint, ChatGPT auth mode, no limits', async () => {
    ports.env.OPENCODE_MODEL_CONTEXT_LIMIT = '8192';
    ports.env.OPENCODE_MODEL_OUTPUT_LIMIT = '4096';
    await expect(
      applyProviderChange(ports, { kind: 'chatgpt', auth: 'subscription', model: 'gpt-test' }),
    ).rejects.toMatchObject({ detail: 'credential_missing' });
    ports.creds.chatgptLogin = true;
    await applyProviderChange(ports, {
      kind: 'chatgpt',
      auth: 'subscription',
      model: 'gpt-test',
      smallModel: 'gpt-mini',
    });
    expect(ports.env).toMatchObject({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'native',
      OPENCODE_AUTH_MODE: 'chatgpt',
      OPENCODE_MODEL: 'openai/gpt-test',
      OPENCODE_SMALL_MODEL: 'openai/gpt-mini',
    });
    expect(ports.env.OPENCODE_MODEL_CONTEXT_LIMIT).toBeUndefined();
    expect(ports.env.OPENCODE_MODEL_OUTPUT_LIMIT).toBeUndefined();
    expect(ports.groups.every((g) => g.provider === 'opencode' && g.model === 'openai/gpt-test')).toBe(true);
  });

  it('sets up ChatGPT with an API key: native endpoint and no ChatGPT auth mode', async () => {
    ports.env.OPENCODE_AUTH_MODE = 'chatgpt';
    ports.creds.chatgptLogin = true; // a login does not satisfy the API-key choice
    await expect(
      applyProviderChange(ports, { kind: 'chatgpt', auth: 'api-key', model: 'gpt-test' }),
    ).rejects.toMatchObject({ detail: 'credential_missing' });
    ports.creds.openaiKey = true;
    await applyProviderChange(ports, { kind: 'chatgpt', auth: 'api-key', model: 'gpt-test' });
    expect(ports.env).toMatchObject({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'native',
      OPENCODE_MODEL: 'openai/gpt-test',
    });
    expect(ports.env.OPENCODE_AUTH_MODE).toBeUndefined();
  });

  it('rolls back a failed switch exactly like an endpoint change', async () => {
    ports.creds.claude = true;
    ports.failOn.setGroup = 'g2';
    await expect(applyProviderChange(ports, { kind: 'claude', model: 'm' })).rejects.toMatchObject({
      code: 'apply_failed_rolled_back',
    });
    expect(ports.groups).toEqual([
      { id: 'g1', provider: 'claude', model: null },
      { id: 'g2', provider: 'opencode', model: 'openrouter/old' },
    ]);
    expect(ports.journal).toBeNull();
  });

  it('previews credentials without changing anything, and rejects malformed model names', async () => {
    const before = JSON.stringify([ports.env, ports.groups]);
    expect(await previewProviderChange(ports, { kind: 'claude' })).toMatchObject({
      ok: false,
      reason: 'credential_missing',
      credential: 'missing',
      groupsAffected: 2,
    });
    ports.creds.claude = true;
    expect(await previewProviderChange(ports, { kind: 'claude' })).toMatchObject({ ok: true, credential: 'present' });
    await expect(
      previewProviderChange(ports, { kind: 'chatgpt', auth: 'api-key', model: 'bad name; x' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(JSON.stringify([ports.env, ports.groups])).toBe(before);
  });

  it('delegates an endpoint to the existing check and apply', async () => {
    const preview = await previewProviderChange(ports, {
      kind: 'compatible',
      baseUrl: 'http://models.test:8000/v1',
      model: 'm1',
    });
    expect(preview).toMatchObject({ ok: true, credential: 'not_needed', models: ['m1', 'm2'], contextLimit: 32768 });
    await applyProviderChange(ports, { kind: 'compatible', baseUrl: 'http://models.test:8000/v1', model: 'm1' });
    expect(ports.env.OPENCODE_BASE_URL).toBe('http://models.test:8000/v1');
  });
});

describe('detectProvider', () => {
  const group = (provider: string | null): GroupModel => ({ id: 'g', provider, model: null });
  it('tells the three setups apart', () => {
    expect(detectProvider({}, [group(null), group('claude')])).toEqual({ kind: 'claude', auth: null });
    expect(
      detectProvider({ OPENCODE_PROVIDER: 'openai', OPENCODE_BASE_URL: 'native', OPENCODE_AUTH_MODE: 'chatgpt' }, [
        group('opencode'),
      ]),
    ).toEqual({ kind: 'chatgpt', auth: 'subscription' });
    expect(detectProvider({ OPENCODE_PROVIDER: 'openai', OPENCODE_BASE_URL: 'native' }, [group('opencode')])).toEqual({
      kind: 'chatgpt',
      auth: 'api-key',
    });
    expect(detectProvider({ OPENCODE_BASE_URL: 'http://models.test:8000/v1' }, [group('opencode')])).toEqual({
      kind: 'compatible',
      auth: null,
    });
    expect(detectProvider({}, [group('opencode')])).toEqual({ kind: 'unknown', auth: null });
  });
});

describe('hardening', () => {
  it('serialises changes: a concurrent apply fails at once and leaves the first one intact', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ports.probe = async () => {
      await gate;
      return GOOD;
    };
    const first = applyModelChange(ports, input);
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({ code: 'change_in_progress' });
    await expect(recoverModelChange(ports)).rejects.toMatchObject({ code: 'change_in_progress' });
    release();
    await expect(first).resolves.toMatchObject({ groups: 2 });
    // The lock is released afterwards, even for a failed change.
    ports.probeResult = { ...GOOD, reason: 'endpoint_unreachable' };
    ports.probe = async () => ports.probeResult;
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({ code: 'probe_failed' });
    ports.probeResult = GOOD;
    await expect(applyModelChange(ports, input)).resolves.toBeDefined();
  });

  it('refuses to start when a current value could not be restored, and changes nothing', async () => {
    ports.env.OPENCODE_BASE_URL = 'it\'s "both"';
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({ detail: 'env_not_restorable' });
    expect(ports.journal).toBeNull();
    expect(ports.env.OPENCODE_MODEL).toBe('openrouter/old');
  });

  it('restores with the restore option, so hand-written previous values come back', async () => {
    const restoreCalls: Array<boolean | undefined> = [];
    const update = ports.updateEnv.bind(ports);
    ports.updateEnv = (changes, options) => {
      restoreCalls.push(options?.restore);
      return update(changes);
    };
    ports.failOn.setGroup = 'g2';
    await expect(applyModelChange(ports, input)).rejects.toMatchObject({ code: 'apply_failed_rolled_back' });
    expect(restoreCalls).toEqual([undefined, true]);
  });

  it('recovery ignores keys that are not managed settings and malformed groups', async () => {
    const written: Array<Record<string, string | null>> = [];
    ports.updateEnv = (changes) => {
      written.push(changes);
      return {};
    };
    ports.journal = {
      startedAt: 'x',
      env: { OPENCODE_MODEL: 'openai/old', NODE_OPTIONS: '--require /x.js', OPENCODE_PROVIDER: 5 as never },
      groups: [{ id: 'g1', provider: 'claude', model: null }, { id: 7 } as never],
    };
    expect(await recoverModelChange(ports)).toBe('rolled-back');
    expect(Object.keys(written[0]).sort()).toEqual(['OPENCODE_MODEL']);
    expect(ports.restarts).toEqual(['g1']);
  });

  it('puts only a stable code in the error detail, never the raw message', async () => {
    ports.updateEnv = () => {
      throw new Error('EACCES: permission denied, open /srv/host.test/.env');
    };
    const error = (await applyModelChange(ports, input).catch((e: unknown) => e)) as ModelSettingsError;
    expect(error.code).toBe('apply_failed_rollback_incomplete');
    expect(error.detail).toBe('rollback_incomplete');
    expect(JSON.stringify(error)).not.toContain('EACCES');
    ports.journal = null;
    ports.env = {};
  });
});
