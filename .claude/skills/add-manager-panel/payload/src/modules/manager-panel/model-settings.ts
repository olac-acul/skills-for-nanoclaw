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
import { log } from '../../log.js';
import { canRestoreValue } from './env-file.js';
import { MODEL_ID, type ProbeResult } from './model-endpoint.js';

export const MANAGED_ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'OPENCODE_AUTH_MODE',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;

export const INPUT_MODALITIES_KEY = 'OPENCODE_MODEL_INPUT_MODALITIES';

/** Whether the setting (a comma list such as `image` or `image,pdf`) names images. */
export function imagesEnabled(value: string | null | undefined): boolean {
  return (value ?? '').split(',').some((entry) => entry.trim().toLowerCase() === 'image');
}

/**
 * The setting with `image` added or taken out. Other entries (audio, video, pdf) stay as they were, in order;
 * `text` is dropped because it is always on. Null when nothing is left, which removes the key from `.env`.
 */
export function withImages(value: string | null | undefined, enabled: boolean): string | null {
  const kept = (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(
      (entry, index, all) => entry !== '' && entry !== 'text' && entry !== 'image' && all.indexOf(entry) === index,
    );
  const list = enabled ? [...kept, 'image'] : kept;
  return list.length > 0 ? list.join(',') : null;
}

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

export interface CredentialPresence {
  /** An Anthropic key or subscription token is stored in the gateway. */
  claude: boolean;
  /** An OpenAI API key is stored for OpenCode. */
  openaiKey: boolean;
  /** A ChatGPT subscription login is stored for OpenCode. */
  chatgptLogin: boolean;
}

export interface ModelPorts {
  credentials(): Promise<CredentialPresence>;
  readEnv(keys: readonly string[]): Record<string, string | null>;
  /** `restore` puts back values that were read from the file, which may not pass the check for new ones. */
  updateEnv(changes: Record<string, string | null>, options?: { restore?: boolean }): Record<string, string | null>;
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
  /** The model accepts images (photos from the phone app). Left as it is when absent. */
  images?: boolean;
}

/**
 * Only one change (or recovery) runs at a time. The flag is set before the first await, so two
 * concurrent requests cannot both pass the check; the second one fails at once.
 */
let changing = false;
async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (changing) throw new ModelSettingsError('change_in_progress', 'another model change is running');
  changing = true;
  try {
    return await run();
  } finally {
    changing = false;
  }
}

/** The raw message stays in the host log; the browser only gets a stable code. */
function failedChange(error: unknown, rolledBack: boolean): ModelSettingsError {
  log.error('Model change failed', { err: error, rolledBack });
  return new ModelSettingsError(
    rolledBack ? 'apply_failed_rolled_back' : 'apply_failed_rollback_incomplete',
    rolledBack
      ? 'the change failed and the previous settings were restored'
      : 'the change failed and restoring the previous settings did not finish',
    rolledBack ? 'apply_error' : 'rollback_incomplete',
  );
}

/** Refuse to start when a value now in `.env` could not be put back afterwards. */
function snapshotEnv(ports: ModelPorts): Record<string, string | null> {
  const env = ports.readEnv(MANAGED_ENV_KEYS);
  if (Object.values(env).some((value) => !canRestoreValue(value))) {
    throw new ModelSettingsError('invalid_input', 'a current setting cannot be restored safely', 'env_not_restorable');
  }
  return env;
}

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
  authMode: string | null;
  /** The install tells the model it can receive images. */
  images: boolean;
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
    authMode: env.OPENCODE_AUTH_MODE,
    images: imagesEnabled(env[INPUT_MODALITIES_KEY]),
    groups: groups.map((group) => ({
      ...group,
      followsSettings: group.provider === 'opencode' && (!expected || group.model === expected),
    })),
    interrupted: ports.readJournal() !== null,
  };
}

/** Whether the small model is on the endpoint's list; `unchecked` when the list is too long to be complete. */
export type SmallModelCheck = 'same' | 'listed' | 'not_found' | 'unchecked';

const LIST_CAP = 200; // probeEndpoint keeps at most this many ids

export function checkSmallModel(probe: ProbeResult, model: string, smallModel: string): SmallModelCheck {
  if (smallModel === model) return 'same';
  if (probe.models.includes(smallModel)) return 'listed';
  return probe.models.length >= LIST_CAP ? 'unchecked' : 'not_found';
}

export interface Preview {
  probe: ProbeResult;
  smallModel: SmallModelCheck;
  groupsAffected: number;
  restartsNeeded: number;
}

/** Check the endpoint and say what applying would touch. Changes nothing. */
export async function previewModelChange(ports: ModelPorts, input: ModelInput): Promise<Preview> {
  const { baseUrl, model, smallModel } = normalise(input);
  const probe = await ports.probe(baseUrl, model);
  const groups = await ports.listGroups();
  return {
    probe,
    smallModel: probe.reason ? 'unchecked' : checkSmallModel(probe, model, smallModel),
    groupsAffected: groups.length,
    restartsNeeded: groups.length,
  };
}

export interface ApplyOutcome {
  groups: number;
  restarted: number;
  restartFailures: string[];
}

/**
 * The context the agents work with, in tokens: the model's window, but never more than this. OpenCode summarizes a
 * conversation (auto-compaction) once it reaches the context limit minus the output limit. The summary is slow on a
 * local model (20 to 90 s measured, while the person waits), and a conversation starts at 25k to 40k tokens of
 * instructions and tools, so a small limit means a summary every few exchanges; the instructions are cached, so a
 * larger one costs little per answer. Too large is slow too: with the whole window of a large model (262k, say) a
 * summary would be never in practice, and a test install had turns of a minute that timed out past 100k tokens.
 */
export const WORKING_CONTEXT = 131_072;

/** The context limit written for a model whose window is [window] tokens. */
export function workingContextFor(window: number): number {
  return Math.min(window, WORKING_CONTEXT);
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
    OPENCODE_MODEL_CONTEXT_LIMIT: probe.contextLimit ? String(workingContextFor(probe.contextLimit)) : null,
    OPENCODE_MODEL_OUTPUT_LIMIT: probe.contextLimit
      ? String(outputLimitFor(workingContextFor(probe.contextLimit)))
      : null,
  };
}

/** Add the image choice to a set of `.env` changes, built on the setting as it was; no choice, no change. */
function withImagesChoice(
  env: Record<string, string | null>,
  before: Record<string, string | null>,
  images: boolean | undefined,
): Record<string, string | null> {
  return images === undefined
    ? env
    : { ...env, [INPUT_MODALITIES_KEY]: withImages(before[INPUT_MODALITIES_KEY], images) };
}

export function applyModelChange(ports: ModelPorts, input: ModelInput): Promise<ApplyOutcome> {
  return exclusive(() => applyModelChangeLocked(ports, input));
}

async function applyModelChangeLocked(ports: ModelPorts, input: ModelInput): Promise<ApplyOutcome> {
  const settings = normalise(input);
  if (ports.readJournal()) {
    throw new ModelSettingsError('change_in_progress', 'a previous model change was interrupted; recover it first');
  }
  const probe = await ports.probe(settings.baseUrl, settings.model);
  if (probe.reason) throw new ModelSettingsError('probe_failed', 'the endpoint did not pass its checks', probe.reason);
  if (checkSmallModel(probe, settings.model, settings.smallModel) === 'not_found') {
    throw new ModelSettingsError('probe_failed', 'the small model is not on the endpoint', 'small_model_not_found');
  }

  const groups = await ports.listGroups();
  const journal: Journal = {
    startedAt: (ports.now?.() ?? new Date()).toISOString(),
    env: snapshotEnv(ports),
    groups,
  };
  ports.writeJournal(journal);

  try {
    ports.updateEnv(withImagesChoice(targetEnv(settings, probe), journal.env, input.images));
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
    throw failedChange(error, await rollbackFromJournal(ports, journal));
  }
}

/** Put the journal's snapshot back. True when everything was restored (the journal is then removed). */
async function rollbackFromJournal(ports: ModelPorts, journal: Journal): Promise<boolean> {
  let complete = true;
  try {
    // A journal file is data on disk: only the managed keys are written, and only string or null values.
    const env: Record<string, string | null> = {};
    for (const key of MANAGED_ENV_KEYS) {
      const value = (journal.env as Record<string, unknown> | null)?.[key];
      if (typeof value === 'string' || value === null) env[key] = value;
    }
    ports.updateEnv(env, { restore: true });
    // eslint-disable-next-line no-catch-all/no-catch-all -- a failed rollback step is recorded so the journal is kept
  } catch (error) {
    log.error('Model rollback could not restore .env', { err: error });
    complete = false;
  }
  for (const group of Array.isArray(journal.groups) ? journal.groups : []) {
    if (typeof group?.id !== 'string') continue;
    try {
      await ports.setGroup(group.id, {
        provider: typeof group.provider === 'string' ? group.provider : null,
        model: typeof group.model === 'string' ? group.model : null,
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed rollback step is recorded so the journal is kept
    } catch {
      complete = false;
    }
  }
  for (const group of Array.isArray(journal.groups) ? journal.groups : []) {
    if (typeof group?.id !== 'string') continue;
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
export function recoverModelChange(ports: ModelPorts): Promise<'none' | 'rolled-back' | 'incomplete'> {
  return exclusive(async () => {
    const journal = ports.readJournal();
    if (!journal) return 'none';
    return (await rollbackFromJournal(ports, journal)) ? 'rolled-back' : 'incomplete';
  });
}

// ---------------------------------------------------------------------------
// Providers: an OpenAI-compatible endpoint, ChatGPT, or Claude
// ---------------------------------------------------------------------------

export type ProviderInput =
  | { kind: 'compatible'; baseUrl: string; model: string; smallModel?: string; images?: boolean }
  | { kind: 'chatgpt'; auth: 'subscription' | 'api-key'; model: string; smallModel?: string; images?: boolean }
  | { kind: 'claude'; model?: string };

export type ProviderKind = ProviderInput['kind'];

function neededCredential(input: ProviderInput, presence: CredentialPresence): 'present' | 'missing' | 'not_needed' {
  if (input.kind === 'compatible') return 'not_needed';
  if (input.kind === 'claude') return presence.claude ? 'present' : 'missing';
  return (input.auth === 'subscription' ? presence.chatgptLogin : presence.openaiKey) ? 'present' : 'missing';
}

export interface ProviderPreview {
  ok: boolean;
  reason: string | null;
  models: string[];
  contextLimit: number | null;
  local: boolean | null;
  /** What the endpoint says about image input; null when it does not say. */
  imageSupport: boolean | null;
  smallModel: SmallModelCheck | 'not_checked';
  credential: 'present' | 'missing' | 'not_needed';
  groupsAffected: number;
  restartsNeeded: number;
}

/** Check a provider choice and say what applying it would touch. Changes nothing. */
export async function previewProviderChange(ports: ModelPorts, input: ProviderInput): Promise<ProviderPreview> {
  const groups = await ports.listGroups();
  const credential = neededCredential(input, await ports.credentials());
  const base = { groupsAffected: groups.length, restartsNeeded: groups.length, credential };
  if (input.kind === 'compatible') {
    const preview = await previewModelChange(ports, input);
    const smallMissing = preview.smallModel === 'not_found';
    return {
      ...base,
      ok: preview.probe.reason === null && !smallMissing,
      reason: preview.probe.reason ?? (smallMissing ? 'small_model_not_found' : null),
      models: preview.probe.models,
      contextLimit: preview.probe.contextLimit,
      local: preview.probe.local, // privacy-scan: allow -- property name
      imageSupport: preview.probe.imageSupport ?? null,
      smallModel: preview.smallModel,
    };
  }
  if (input.kind === 'chatgpt' && !MODEL_ID.test(input.model))
    throw new ModelSettingsError('invalid_input', 'a model name is required');
  if (input.kind === 'claude' && input.model !== undefined && input.model !== '' && !MODEL_ID.test(input.model)) {
    throw new ModelSettingsError('invalid_input', 'model ids may contain letters, digits and . _ : / @ + -');
  }
  // The key lives in the gateway and cannot be read back, so the model name itself cannot be checked here.
  return {
    ...base,
    ok: credential === 'present',
    reason: credential === 'present' ? null : 'credential_missing',
    models: [],
    contextLimit: null,
    local: null,
    imageSupport: null,
    smallModel: 'not_checked',
  };
}

function envFor(input: ProviderInput, probe: ProbeResult | null): Record<string, string | null> {
  if (input.kind === 'compatible') return targetEnv(normalise(input), probe as ProbeResult);
  if (input.kind === 'chatgpt') {
    const small = (input.smallModel ?? '').trim() || input.model;
    return {
      OPENCODE_PROVIDER: 'openai',
      OPENCODE_BASE_URL: 'native',
      OPENCODE_MODEL: `openai/${input.model}`,
      OPENCODE_SMALL_MODEL: `openai/${small}`,
      OPENCODE_AUTH_MODE: input.auth === 'subscription' ? 'chatgpt' : null,
      OPENCODE_MODEL_CONTEXT_LIMIT: null,
      OPENCODE_MODEL_OUTPUT_LIMIT: null,
    };
  }
  return {}; // Claude does not use the OPENCODE_* settings; they are left as they are.
}

function groupValueFor(input: ProviderInput): { provider: string | null; model: string | null } {
  if (input.kind === 'claude') return { provider: null, model: input.model?.trim() || null };
  const model = input.kind === 'compatible' ? normalise(input).model : input.model.trim();
  return { provider: 'opencode', model: `openai/${model}` };
}

/** Point every agent at the chosen provider. Same journal and rollback as an endpoint change. */
export function applyProviderChange(ports: ModelPorts, input: ProviderInput): Promise<ApplyOutcome> {
  if (input.kind === 'compatible') return applyModelChange(ports, input);
  return exclusive(() => applyProviderChangeLocked(ports, input));
}

async function applyProviderChangeLocked(ports: ModelPorts, input: ProviderInput): Promise<ApplyOutcome> {
  if (ports.readJournal()) {
    throw new ModelSettingsError('change_in_progress', 'a previous model change was interrupted; recover it first');
  }
  const preview = await previewProviderChange(ports, input);
  if (!preview.ok)
    throw new ModelSettingsError('probe_failed', 'the provider is not ready', preview.reason ?? 'credential_missing');

  const target = groupValueFor(input);
  const env = envFor(input, null);
  const groups = await ports.listGroups();
  const journal: Journal = {
    startedAt: (ports.now?.() ?? new Date()).toISOString(),
    env: snapshotEnv(ports),
    groups,
  };
  ports.writeJournal(journal);
  try {
    const changes = input.kind === 'claude' ? env : withImagesChoice(env, journal.env, input.images);
    if (Object.keys(changes).length > 0) ports.updateEnv(changes);
    for (const group of groups) await ports.setGroup(group.id, target);

    const after = await ports.listGroups();
    if (after.some((group) => group.provider !== target.provider || group.model !== target.model))
      throw new Error('a group was not updated');
    if (env.OPENCODE_MODEL !== undefined && ports.readEnv(['OPENCODE_MODEL']).OPENCODE_MODEL !== env.OPENCODE_MODEL) {
      throw new Error('the .env file does not contain the new settings');
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
    ports.clearJournal();
    return { groups: groups.length, restarted: groups.length - restartFailures.length, restartFailures };
  } catch (error) {
    throw failedChange(error, await rollbackFromJournal(ports, journal));
  }
}

/** Which provider the install is set up for, judged from `.env` and the groups. */
export function detectProvider(
  env: Record<string, string | null>,
  groups: GroupModel[],
): { kind: ProviderKind | 'unknown'; auth: 'subscription' | 'api-key' | null } {
  if (groups.length > 0 && groups.every((group) => group.provider === null || group.provider === 'claude'))
    return { kind: 'claude', auth: null };
  if (env.OPENCODE_PROVIDER === 'openai' && env.OPENCODE_BASE_URL === 'native') {
    return { kind: 'chatgpt', auth: env.OPENCODE_AUTH_MODE === 'chatgpt' ? 'subscription' : 'api-key' };
  }
  if (env.OPENCODE_BASE_URL && env.OPENCODE_BASE_URL !== 'native') return { kind: 'compatible', auth: null };
  return { kind: 'unknown', auth: null };
}
