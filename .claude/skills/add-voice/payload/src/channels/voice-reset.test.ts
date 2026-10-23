/**
 * Integration test for "new conversation": `clearVoiceConversation` against a real central DB and a real
 * session folder. The app's user is not an admin, so the adapter writes the `/clear` itself into the chat's
 * session; red if that row stops landing in inbound.db, lands in another chat's session, or the container
 * is not woken to process it.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice-reset' };
});
vi.mock('../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import { requestWake } from '../request-wake.js';
import { resolveSession } from '../session-manager.js';
import { clearVoiceConversation } from './voice.js';

const TEST_DIR = '/tmp/nanoclaw-test-voice-reset';
const now = () => new Date().toISOString();

async function chat(id: string, channelType: string, platformId: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: id,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: `mga-${id}`,
    messaging_group_id: id,
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function inboundTexts(sessionId: string): string[] {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    const rows = db.prepare('SELECT kind, content FROM messages_in ORDER BY seq').all() as Array<{
      kind: string;
      content: string;
    }>;
    return rows.map((r) => `${r.kind}:${JSON.parse(r.content).text}`);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Assistant',
    folder: 'assistant',
    agent_provider: null,
    created_at: now(),
  });
  vi.mocked(requestWake).mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('clearVoiceConversation', () => {
  it("writes /clear into the voice chat's session only and wakes its container", async () => {
    await chat('mg-voice', 'voice', 'voice:default');
    await chat('mg-telegram', 'telegram', 'telegram:1'); // same agent, another chat: must stay untouched
    const { session: voice } = await resolveSession('ag-1', 'mg-voice', null, 'shared');
    const { session: telegram } = await resolveSession('ag-1', 'mg-telegram', null, 'shared');

    expect(await clearVoiceConversation('voice:default')).toBe(1);

    expect(inboundTexts(voice.id)).toEqual(['chat:/clear']);
    expect(inboundTexts(telegram.id)).toEqual([]);
    expect(vi.mocked(requestWake)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestWake).mock.calls[0][0].id).toBe(voice.id);
  });

  it('writes the /clear under the id it is given, so its reply can be tied to a request', async () => {
    await chat('mg-voice', 'voice', 'voice:default');
    const { session } = await resolveSession('ag-1', 'mg-voice', null, 'shared');
    expect(await clearVoiceConversation('voice:default', 'voice-clear-test1')).toBe(1);
    const db = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
    try {
      expect(db.prepare('SELECT id FROM messages_in').all()).toEqual([{ id: 'voice-clear-test1' }]);
    } finally {
      db.close();
    }
  });

  it('does nothing when the chat has no conversation yet', async () => {
    await chat('mg-voice', 'voice', 'voice:default');
    expect(await clearVoiceConversation('voice:default')).toBe(0);
    expect(vi.mocked(requestWake)).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown chat', async () => {
    expect(await clearVoiceConversation('voice:nobody')).toBe(0);
  });
});
