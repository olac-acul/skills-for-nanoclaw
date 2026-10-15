/** A fake install for panel tests: in-memory data with recognisable canary values. */
import fs from 'node:fs';
import path from 'node:path';

import type { BackupRecord } from '../../manager-backup/service.js';
import type { AgentInfo, PanelBackend } from '../backend.js';
import type { CredentialsPort, LoginState } from '../credentials.js';
import type { GroupModel, Journal, ModelPorts } from '../model-settings.js';
import type { ProbeResult } from '../model-endpoint.js';
import type { PhonePort, PhoneStatus } from '../phone.js';

export const CANARY = 'CANARY-7f3a91';

export interface FakeBackend extends PanelBackend {
  agentList: AgentInfo[];
  env: Record<string, string | null>;
  groups: GroupModel[];
  journal: Journal | null;
  restarts: string[];
  probeResult: ProbeResult;
  records: BackupRecord[];
  createCalls: Array<{ waitMs?: number; force?: boolean }>;
  /** While set, create() stays in progress until it resolves. */
  createGate: Promise<void> | null;
  busy: boolean;
  creds: { claude: boolean; openaiKey: boolean; chatgptLogin: boolean };
  saved: Array<{ kind: string; length: number }>;
  removed: string[];
  login: LoginState;
  loginCancelled: boolean;
  phoneState: PhoneStatus;
  tokensMade: number;
  enabledCalls: boolean[];
}

export function fakeBackend(dir: string): FakeBackend {
  const self: FakeBackend = {
    agentList: [
      {
        id: `internal-folder-${CANARY}-one`,
        name: 'Alpha',
        provider: 'claude',
        model: null,
        running: true,
        sessions: 2,
      },
      {
        id: `internal-folder-${CANARY}-two`,
        name: 'Beta',
        provider: 'opencode',
        model: 'openai/old',
        running: false,
        sessions: 0,
      },
    ],
    env: { OPENCODE_PROVIDER: 'openai', OPENCODE_BASE_URL: 'http://models.test:8000/v1', OPENCODE_MODEL: 'openai/old' },
    groups: [
      { id: `internal-folder-${CANARY}-one`, provider: 'claude', model: null },
      { id: `internal-folder-${CANARY}-two`, provider: 'opencode', model: 'openai/old' },
    ],
    journal: null,
    restarts: [],
    probeResult: { reason: null, models: ['qwen', 'llama'], contextLimit: 16384, local: true },
    records: [],
    createCalls: [],
    createGate: null,
    busy: false,
    creds: { claude: false, openaiKey: false, chatgptLogin: false },
    saved: [],
    removed: [],
    login: { state: 'idle' },
    loginCancelled: false,
    phoneState: {
      installed: true,
      enabled: true,
      listening: true,
      connected: true,
      connectedAt: '2026-10-02T12:00:00.000Z',
      lastDisconnectAt: null,
      locale: 'it-IT',
      url: 'ws://100.64.0.9:8767',
      addressProblem: null,
      tokenSet: true,
      pushRegistered: true,
      agent: 'Alpha',
      restartNeeded: false,
    },
    tokensMade: 0,
    enabledCalls: [],
    phone: {
      status: async () => ({ ...self.phoneState }),
      async newToken() {
        self.tokensMade += 1;
        self.phoneState.tokenSet = true;
        return `fake-token-${CANARY}-${'t'.repeat(30)}`;
      },
      async setEnabled(enabled) {
        self.enabledCalls.push(enabled);
        self.phoneState.enabled = enabled;
        self.phoneState.restartNeeded = true;
      },
    } satisfies PhonePort,
    bridgeAddress: () => '100.64.0.1',
    credentials: {
      status: async () => ({ ...self.creds }),
      async saveClaude(value) {
        self.saved.push({ kind: 'claude', length: value.length });
        self.creds.claude = true;
      },
      async saveOpenAiKey(value) {
        self.saved.push({ kind: 'openai-key', length: value.length });
        self.creds.openaiKey = true;
      },
      async removeCredential(kind) {
        self.removed.push(kind);
        if (kind === 'claude') self.creds.claude = false;
        else if (kind === 'openai-key') self.creds.openaiKey = false;
        else self.creds.chatgptLogin = false;
      },
      startChatgptLogin() {
        self.login = { state: 'waiting', url: 'https://login.example.test/device', code: 'ABCD-12345' };
        return self.login;
      },
      loginState: () => self.login,
      cancelChatgptLogin() {
        self.loginCancelled = true;
        self.login = { state: 'error', error: 'login_cancelled' };
      },
    } satisfies CredentialsPort,
    async overview() {
      return {
        release: '2.4.0',
        gateway: 'onecli',
        channels: ['telegram'],
        providers: ['opencode'],
        agents: 2,
        runningAgents: 1,
        sessions: 2,
        uptimeSeconds: 3700,
      };
    },
    agents: async () => self.agentList,
    async restartAgent(id) {
      self.restarts.push(id);
    },
    channels: async () => [{ type: 'telegram', chats: 3 }],
    model: {
      readEnv: (keys) => Object.fromEntries(keys.map((key) => [key, self.env[key] ?? null])),
      updateEnv(changes) {
        const before = Object.fromEntries(Object.keys(changes).map((key) => [key, self.env[key] ?? null]));
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) delete self.env[key];
          else self.env[key] = value;
        }
        return before;
      },
      listGroups: async () => self.groups.map((group) => ({ ...group })),
      async setGroup(id, value) {
        const group = self.groups.find((entry) => entry.id === id)!;
        group.provider = value.provider;
        group.model = value.model;
      },
      async restartGroup(id) {
        self.restarts.push(id);
      },
      credentials: async () => ({ ...self.creds }),
      probe: async () => self.probeResult,
      readJournal: () => self.journal,
      writeJournal: (journal) => {
        self.journal = journal;
      },
      clearJournal: () => {
        self.journal = null;
      },
    } satisfies ModelPorts,
    backups: {
      list: () => [...self.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      async create(options) {
        self.createCalls.push({ waitMs: options.waitMs, force: options.force });
        if (self.createGate) await self.createGate;
        options.onProgress?.({ phase: 'snapshot', entries: 0, bytes: 0 });
        options.onProgress?.({ phase: 'pack', entries: 10, bytes: 1234 });
        if (self.busy && !options.force) {
          const { BackupError } = await import('../../manager-backup/service.js');
          throw new BackupError('agents_busy', 'busy');
        }
        const id = `20261002T1200${String(self.records.length).padStart(2, '0')}Z-abcdef`;
        const record: BackupRecord = {
          id,
          createdAt: `2026-10-02T12:00:0${self.records.length}.000Z`,
          bytes: 1234,
          release: '2.4.0',
          commit: 'a'.repeat(40),
          consistency: self.busy ? 'best-effort' : 'quiescent',
          entries: 10,
          files: 5,
          contentBytes: 999,
          machineIdentity: false,
        };
        self.records.push(record);
        fs.writeFileSync(path.join(dir, `${id}.mbk`), 'encrypted-bytes');
        return { record, key: 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee-ffffffff-00000000-11111111' };
      },
      async verify(_id, key) {
        if (key !== 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee-ffffffff-00000000-11111111') {
          const { CryptoError } = await import('../../manager-backup/crypto.js');
          throw new CryptoError('authentication_failed', 'wrong key');
        }
        return {
          manifest: { source: { version: '2.4.0' }, consistency: 'quiescent' },
          entries: 10,
          files: 5,
          bytes: 999,
        } as never;
      },
      delete(id) {
        self.records = self.records.filter((record) => record.id !== id);
      },
      fileFor(id) {
        if (!self.records.some((record) => record.id === id)) throw new Error('not found');
        return path.join(dir, `${id}.mbk`);
      },
    },
  };
  return self;
}
