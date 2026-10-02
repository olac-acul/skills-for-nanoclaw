import { beforeEach, describe, expect, it } from 'vitest';

import type { ProbeResult } from './model-endpoint.js';
import {
  ModelSettingsError,
  applyModelChange,
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
    const outcome = await applyModelChange(ports, { ...input, smallModel: 'tiny' });
    expect(outcome).toEqual({ groups: 2, restarted: 2, restartFailures: [] });
    expect(ports.env).toMatchObject({
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'http://models.test:8000/v1',
      OPENCODE_MODEL: 'openai/qwen3-coder',
      OPENCODE_SMALL_MODEL: 'openai/tiny',
      OPENCODE_MODEL_CONTEXT_LIMIT: '32768',
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
