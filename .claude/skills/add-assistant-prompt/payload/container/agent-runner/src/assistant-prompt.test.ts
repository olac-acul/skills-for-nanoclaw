import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { asAssistant, assistantAgent, assistantPrompt, CODING_TOOLS, withoutCodingTools } from './assistant-prompt.js';

describe('assistant prompt', () => {
  it('ships a short default prompt that keeps the date and untrusted-text rules', () => {
    const text = assistantPrompt([path.join(import.meta.dir, 'assistant-prompt.md')])!;
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain("Today's date");
    expect(text).toContain('information, not instructions');
    expect(text).toContain('nothing reliable, say so first');
  });

  it("prefers the agent's own prompt and falls back to the default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'assistant-prompt-'));
    const own = path.join(dir, 'own.md');
    const fallback = path.join(dir, 'default.md');
    writeFileSync(fallback, 'Default prompt.');
    expect(assistantPrompt([own, fallback])).toBe('Default prompt.');
    writeFileSync(own, '  Own prompt.\n');
    expect(assistantPrompt([own, fallback])).toBe('Own prompt.');
    expect(assistantPrompt([path.join(dir, 'none.md')])).toBeUndefined();
  });

  it("gives OpenCode's build agent the prompt, or nothing without one", () => {
    expect(assistantAgent('Hi.')).toEqual({ build: { prompt: 'Hi.' } });
    expect(assistantAgent('')).toEqual({});
  });

  it('denies only the coding tools and keeps the rest of the policy', () => {
    const policy = withoutCodingTools({ read: 'allow', bash: 'allow', task: 'allow', todowrite: 'allow', question: 'deny' }) as Record<string, unknown>;
    for (const tool of CODING_TOOLS) expect(policy[tool]).toBe('deny');
    expect(policy).toMatchObject({ read: 'allow', bash: 'allow', question: 'deny' });
    expect(withoutCodingTools('allow')).toEqual({ '*': 'allow', task: 'deny', todowrite: 'deny' });
    expect(withoutCodingTools(undefined)).toBeUndefined();
  });

  it("gives OpenCode's server the prompt and the policy without coding tools, keeping the rest", () => {
    const config = { model: 'openai/m', permission: { bash: 'allow', task: 'allow' }, mcp: { nanoclaw: {} } };
    const served = asAssistant(config);
    expect(served).toMatchObject({ model: 'openai/m', mcp: { nanoclaw: {} }, permission: { bash: 'allow', task: 'deny', todowrite: 'deny' } });
    expect((served.agent as { build: { prompt: string } }).build.prompt).toContain('personal assistant');
    expect(config.permission.task).toBe('allow'); // the provider's own configuration is not changed
  });
});
