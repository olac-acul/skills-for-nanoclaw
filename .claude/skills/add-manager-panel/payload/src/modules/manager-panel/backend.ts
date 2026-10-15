/**
 * What the panel needs from the running NanoClaw install. The server and the
 * routes only know this interface; `upstream-backend.ts` is the one file that
 * implements it with upstream internals, and tests implement it with fakes.
 */
import type { BackupRecord, CreateOptions } from '../manager-backup/service.js';
import type { VerifyResult } from '../manager-backup/bundle.js';
import type { CredentialsPort } from './credentials.js';
import type { ModelPorts } from './model-settings.js';
import type { PhonePort } from './phone.js';

export interface Overview {
  release: string;
  gateway: string | null;
  channels: string[];
  providers: string[];
  agents: number;
  runningAgents: number;
  sessions: number;
  uptimeSeconds: number;
}

export interface AgentInfo {
  /** Internal id; never sent to the browser as is. */
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  running: boolean;
  sessions: number;
}

export interface ChannelInfo {
  type: string;
  chats: number;
}

export interface BackupPort {
  list(): BackupRecord[];
  create(options: CreateOptions): Promise<{ record: BackupRecord; key: string }>;
  verify(id: string, key: string): Promise<VerifyResult>;
  delete(id: string): void;
  fileFor(id: string): string;
}

export interface PanelBackend {
  overview(): Promise<Overview>;
  agents(): Promise<AgentInfo[]>;
  restartAgent(id: string): Promise<void>;
  channels(): Promise<ChannelInfo[]>;
  model: ModelPorts;
  credentials: CredentialsPort;
  /** The Docker bridge address as seen from the host, where a model server on this machine is reachable from agents. */
  bridgeAddress(): string | null;
  backups: BackupPort;
  /** The phone app (voice channel) page. */
  phone: PhonePort;
}
