/**
 * The real `PanelBackend`, backed by upstream NanoClaw internals. With
 * `index.ts` this is the only panel code that imports upstream modules.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { isContainerRunning } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import {
  ensureContainerConfig,
  getAllContainerConfigs,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { getCodeVersion } from '../../upgrade-state.js';
import { readInventory } from '../manager-backup/upstream-host.js';
import type { AgentInfo, BackupPort, PanelBackend } from './backend.js';
import type { CredentialsPort } from './credentials.js';
import { readEnvKeys, updateEnvKeys } from './env-file.js';
import { liveEndpointDeps, probeEndpoint } from './model-endpoint.js';
import { JOURNAL_NAME, type GroupModel, type Journal, type ModelPorts } from './model-settings.js';
import { createPhonePort } from './phone.js';
import type { PanelState } from './state.js';

/** The first IPv4 gateway in the output of `docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}'`. */
export function parseBridgeGateway(output: string): string | null {
  const match = output.split(/\s+/).find((word) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(word));
  return match ?? null;
}

/**
 * Where agent containers reach this machine: the address of the Docker bridge. The interface is
 * only listed while it is up (a container is running), so Docker is asked when it is not.
 */
function findBridgeAddress(): string | null {
  const bridge = os.networkInterfaces().docker0?.find((entry) => entry.family === 'IPv4');
  if (bridge) return bridge.address;
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return parseBridgeGateway(out);
    // eslint-disable-next-line no-catch-all/no-catch-all -- no Docker, or it is down: the address is simply unknown
  } catch {
    return null;
  }
}

export interface UpstreamBackendOptions {
  projectRoot: string;
  state: PanelState;
  backups: BackupPort;
  credentials: CredentialsPort;
}

export function createModelPorts(
  options: Pick<UpstreamBackendOptions, 'projectRoot' | 'state' | 'credentials'>,
): ModelPorts {
  const envFile = path.join(options.projectRoot, '.env');
  return {
    readEnv: (keys) => readEnvKeys(envFile, keys),
    updateEnv: (changes, options) => updateEnvKeys(envFile, changes, options),
    async listGroups(): Promise<GroupModel[]> {
      // Every group gets a config row before it is read, so none is skipped.
      for (const group of await getAllAgentGroups()) await ensureContainerConfig(group.id);
      return (await getAllContainerConfigs()).map((row) => ({
        id: row.agent_group_id,
        provider: row.provider ?? null,
        model: row.model ?? null,
      }));
    },
    async setGroup(id, value) {
      await updateContainerConfigScalars(id, { provider: value.provider, model: value.model });
    },
    async restartGroup(id) {
      await restartAgentGroupContainers(id, 'model settings changed from the panel');
    },
    credentials: () => options.credentials.status(),
    probe: (baseUrl, model) => probeEndpoint(baseUrl, model, liveEndpointDeps()),
    readJournal: () => options.state.readDocument<Journal>(JOURNAL_NAME),
    writeJournal: (journal) => options.state.writeDocument(JOURNAL_NAME, journal),
    clearJournal: () => options.state.removeDocument(JOURNAL_NAME),
  };
}

let bridgeCache: string | null = null;

export function createUpstreamBackend(options: UpstreamBackendOptions): PanelBackend {
  const startedAt = Date.now();

  async function agents(): Promise<AgentInfo[]> {
    const db = getDb();
    const groups = await getAllAgentGroups();
    const configs = new Map((await getAllContainerConfigs()).map((row) => [row.agent_group_id, row]));
    const sessions = await db.all<{ id: string; agent_group_id: string }>('SELECT id, agent_group_id FROM sessions');
    return groups.map((group) => {
      const own = sessions.filter((session) => session.agent_group_id === group.id);
      const config = configs.get(group.id);
      return {
        id: group.id,
        name: group.name,
        provider: config?.provider ?? null,
        model: config?.model ?? null,
        running: own.some((session) => isContainerRunning(session.id)),
        sessions: own.length,
      };
    });
  }

  return {
    agents,
    async overview() {
      const list = await agents();
      const inventory = readInventory(options.projectRoot);
      return {
        release: getCodeVersion(options.projectRoot),
        gateway: inventory.gateway,
        channels: inventory.channels,
        providers: [...new Set([...inventory.providers, ...inventory.containerProviders])].sort(),
        agents: list.length,
        runningAgents: list.filter((agent) => agent.running).length,
        sessions: list.reduce((sum, agent) => sum + agent.sessions, 0),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      };
    },
    async restartAgent(id) {
      await restartAgentGroupContainers(id, 'restarted from the panel');
    },
    async channels() {
      const rows = await getDb().all<{ channel_type: string; chats: number }>(
        'SELECT channel_type, COUNT(*) AS chats FROM messaging_groups GROUP BY channel_type ORDER BY channel_type',
      );
      return rows.map((row) => ({ type: row.channel_type, chats: Number(row.chats) }));
    },
    model: createModelPorts(options),
    credentials: options.credentials,
    bridgeAddress: () => (bridgeCache ??= findBridgeAddress()),
    backups: options.backups,
    phone: createPhonePort({
      projectRoot: options.projectRoot,
      installed: () => readInventory(options.projectRoot).channels.includes('voice'),
      async wiredAgents() {
        const rows = await getDb().all<{ name: string }>(
          `SELECT ag.name AS name FROM messaging_groups mg
             JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
             JOIN agent_groups ag ON ag.id = mga.agent_group_id
            WHERE mg.channel_type = 'voice' ORDER BY ag.name`,
        );
        return rows.map((row) => row.name);
      },
    }),
  };
}
