/**
 * Switching every agent to one OpenAI-compatible model endpoint, with a way back.
 *
 * Uses only mechanisms upstream already has: the `OPENCODE_*` keys in `.env`
 * and each group's container config (`provider`, `model`). There is no
 * precedence layer of our own. A journal written before the first change holds
 * the previous `.env` values and every group's previous provider and model, so
 * a failure at any step (or a crash, recovered at the next start) puts it all
 * back and restarts the groups again.
 *
 * API keys are not handled here: they belong in the credential gateway. A
 * keyless endpoint, or one whose key is already stored there, works as is.
 */
import type { ProbeResult } from './model-endpoint.js';

export const MANAGED_ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'OPENCODE_AUTH_MODE',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
] as const;

export const JOURNAL_NAME = 'model-journal.json';

export class ModelSettingsError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'probe_failed'
      | 'apply_failed_rolled_back'
      | 'apply_failed_rollback_incomplete'
      | 'change_in_progress',
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ModelSettingsError';
  }
}

export interface GroupModel {
  id: string;
  provider: string | null;
  model: string | null;
}

export interface Journal {
  startedAt: string;
  env: Record<string, string | null>;
  groups: GroupModel[];
}

export interface ModelPorts {
  readEnv(keys: readonly string[]): Record<string, string | null>;
  updateEnv(changes: Record<string, string | null>): Record<string, string | null>;
  listGroups(): Promise<GroupModel[]>;
  setGroup(id: string, value: { provider: string | null; model: string | null }): Promise<void>;
  restartGroup(id: string): Promise<void>;
  probe(baseUrl: string, model: string | null): Promise<ProbeResult>;
  readJournal(): Journal | null;
  writeJournal(journal: Journal): void;
  clearJournal(): void;
  now?: () => Date;
}

export interface ModelInput {
  baseUrl: string;
  model: string;
  smallModel?: string;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function normalise(input: ModelInput): { baseUrl: string; model: string; smallModel: string } {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  const model = input.model.trim();
  const smallModel = (input.smallModel ?? '').trim() || model;
  if (!MODEL_ID.test(model) || !MODEL_ID.test(smallModel)) {
    throw new ModelSettingsError('invalid_input', 'model ids may contain letters, digits and . _ : / @ + -');
  }
  if (baseUrl.length === 0 || baseUrl.length > 2048)
    throw new ModelSettingsError('invalid_input', 'a base URL is required');
  return { baseUrl, model, smallModel };
}

export interface ModelStatus {
  baseUrl: string | null;
  model: string | null;
  smallModel: string | null;
  provider: string | null;
  groups: Array<{ id: string; provider: string | null; model: string | null; followsSettings: boolean }>;
  /** A change was interrupted and has not been recovered yet. */
  interrupted: boolean;
}

export async function readModelStatus(ports: ModelPorts): Promise<ModelStatus> {
  const env = ports.readEnv(MANAGED_ENV_KEYS);
  const groups = await ports.listGroups();
  const expected = env.OPENCODE_MODEL;
  return {
    baseUrl: env.OPENCODE_BASE_URL,
    model: env.OPENCODE_MODEL,
    smallModel: env.OPENCODE_SMALL_MODEL,
    provider: env.OPENCODE_PROVIDER,
    groups: groups.map((group) => ({
      ...group,
      followsSettings: group.provider === 'opencode' && (!expected || group.model === expected),
    })),
    interrupted: ports.readJournal() !== null,
  };
}

export interface Preview {
  probe: ProbeResult;
  groupsAffected: number;
  restartsNeeded: number;
}

/** Check the endpoint and say what applying would touch. Changes nothing. */
export async function previewModelChange(ports: ModelPorts, input: ModelInput): Promise<Preview> {
  const { baseUrl, model } = normalise(input);
  const probe = await ports.probe(baseUrl, model);
  const groups = await ports.listGroups();
  return { probe, groupsAffected: groups.length, restartsNeeded: groups.length };
}

export interface ApplyOutcome {
  groups: number;
  restarted: number;
  restartFailures: string[];
}

/**
 * OpenCode's model schema wants an output limit whenever a context limit is
 * given. Half the window, at most 4096 tokens, is a safe default for a model
 * whose real output limit the endpoint does not report.
 */
export function outputLimitFor(contextLimit: number): number {
  return Math.min(4096, Math.max(256, Math.floor(contextLimit / 2)));
}

function targetEnv(
  settings: { baseUrl: string; model: string; smallModel: string },
  probe: ProbeResult,
): Record<string, string | null> {
  return {
    OPENCODE_PROVIDER: 'openai',
    OPENCODE_BASE_URL: settings.baseUrl,
    OPENCODE_MODEL: `openai/${settings.model}`,
    OPENCODE_SMALL_MODEL: `openai/${settings.smallModel}`,
    OPENCODE_AUTH_MODE: null, // API-key (or keyless) mode; clears a leftover ChatGPT sign-in mode
    // Both limits or neither: a context limit alone makes OpenCode reject the model definition.
    OPENCODE_MODEL_CONTEXT_LIMIT: probe.contextLimit ? String(probe.contextLimit) : null,
    OPENCODE_MODEL_OUTPUT_LIMIT: probe.contextLimit ? String(outputLimitFor(probe.contextLimit)) : null,
  };
}

export async function applyModelChange(ports: ModelPorts, input: ModelInput): Promise<ApplyOutcome> {
  const settings = normalise(input);
  if (ports.readJournal()) {
    throw new ModelSettingsError('change_in_progress', 'a previous model change was interrupted; recover it first');
  }
  const probe = await ports.probe(settings.baseUrl, settings.model);
  if (probe.reason) throw new ModelSettingsError('probe_failed', 'the endpoint did not pass its checks', probe.reason);

  const groups = await ports.listGroups();
  const journal: Journal = {
    startedAt: (ports.now?.() ?? new Date()).toISOString(),
    env: ports.readEnv(MANAGED_ENV_KEYS),
    groups,
  };
  ports.writeJournal(journal);

  try {
    ports.updateEnv(targetEnv(settings, probe));
    for (const group of groups)
      await ports.setGroup(group.id, { provider: 'opencode', model: `openai/${settings.model}` });

    // Verify what was written before restarting anything.
    const env = ports.readEnv(MANAGED_ENV_KEYS);
    if (env.OPENCODE_BASE_URL !== settings.baseUrl || env.OPENCODE_MODEL !== `openai/${settings.model}`) {
      throw new Error('the .env file does not contain the new settings');
    }
    const after = await ports.listGroups();
    if (after.some((group) => group.provider !== 'opencode' || group.model !== `openai/${settings.model}`)) {
      throw new Error('a group was not updated');
    }

    const restartFailures: string[] = [];
    for (const group of groups) {
      try {
        await ports.restartGroup(group.id);
        // eslint-disable-next-line no-catch-all/no-catch-all -- a restart failure is reported to the caller, the change itself stands
      } catch {
        restartFailures.push(group.id);
      }
    }
    // The change itself stands even if a restart failed; those groups pick it up on their next start.
    ports.clearJournal();
    return { groups: groups.length, restarted: groups.length - restartFailures.length, restartFailures };
  } catch (error) {
    const rolledBack = await rollbackFromJournal(ports, journal);
    throw new ModelSettingsError(
      rolledBack ? 'apply_failed_rolled_back' : 'apply_failed_rollback_incomplete',
      rolledBack
        ? 'the change failed and the previous settings were restored'
        : 'the change failed and restoring the previous settings did not finish',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Put the journal's snapshot back. True when everything was restored (the journal is then removed). */
async function rollbackFromJournal(ports: ModelPorts, journal: Journal): Promise<boolean> {
  let complete = true;
  try {
    ports.updateEnv(journal.env);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a failed rollback step is recorded so the journal is kept
  } catch {
    complete = false;
  }
  for (const group of journal.groups) {
    try {
      await ports.setGroup(group.id, { provider: group.provider, model: group.model });
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed rollback step is recorded so the journal is kept
    } catch {
      complete = false;
    }
  }
  for (const group of journal.groups) {
    try {
      await ports.restartGroup(group.id);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a group that cannot restart now starts on the restored settings next time
    } catch {
      // A group that cannot restart now will start on the restored settings next time.
    }
  }
  if (complete) ports.clearJournal();
  return complete;
}

/** Called at host start: an interrupted change is rolled back. */
export async function recoverModelChange(ports: ModelPorts): Promise<'none' | 'rolled-back' | 'incomplete'> {
  const journal = ports.readJournal();
  if (!journal) return 'none';
  return (await rollbackFromJournal(ports, journal)) ? 'rolled-back' : 'incomplete';
}
