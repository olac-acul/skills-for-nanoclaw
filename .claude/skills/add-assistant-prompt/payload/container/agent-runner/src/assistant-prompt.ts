/**
 * OpenCode is built to write code: its own system prompt (style, code conventions, code references, about 1,900
 * tokens) and two tools a personal assistant does not use, `task` (sub-agents) and `todowrite` (a coding to-do
 * list, about 1,500 tokens together), go into every prompt. This gives OpenCode's agent a short assistant prompt
 * instead (assistant-prompt.md, or the agent's own `assistant-prompt.md` in its folder) and switches the two tools
 * off. NanoClaw's instructions for the agent come after it, unchanged.
 *
 * Applied where the OpenCode provider hands its configuration to the server (`buildOpenCodeServerEnv`, a seam, see
 * scripts/assistant-prompt-seams.mjs), so the configuration the provider builds, and upstream's tests of it, stay
 * as they are.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The agent's folder in the container: a prompt kept there replaces the default one for that agent. */
const AGENT_PROMPT = '/workspace/agent/assistant-prompt.md';

/** OpenCode tools an assistant does not use: sub-agents and coding to-do lists. */
export const CODING_TOOLS = ['task', 'todowrite'] as const;

/** The prompt text: the agent's own file if it has one, else the default; undefined when neither can be read. */
export function assistantPrompt(files: string[] = [AGENT_PROMPT, path.join(HERE, 'assistant-prompt.md')]): string | undefined {
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch {
      // not there: the next one
    }
  }
  return undefined;
}

/** OpenCode's `agent` setting: the build agent with the assistant prompt, or nothing (OpenCode's own prompt). */
export function assistantAgent(prompt: string | undefined = assistantPrompt()): Record<string, unknown> {
  return prompt ? { build: { prompt } } : {};
}

/**
 * The permission policy with the coding-only tools denied: OpenCode then leaves them out of the prompt. A policy that
 * is one word for every tool ("allow") becomes the same word for `*`; anything else that is not an object is kept.
 */
export function withoutCodingTools(policy: unknown): unknown {
  const denied = Object.fromEntries(CODING_TOOLS.map((tool) => [tool, 'deny']));
  if (typeof policy === 'string') return { '*': policy, ...denied };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return policy;
  return { ...policy, ...denied };
}

/** The configuration OpenCode's server gets: the assistant prompt and the coding tools denied. */
export function asAssistant(config: Record<string, unknown>): Record<string, unknown> {
  const agent = config.agent && typeof config.agent === 'object' ? config.agent : {};
  return { ...config, permission: withoutCodingTools(config.permission), agent: { ...assistantAgent(), ...agent } };
}
