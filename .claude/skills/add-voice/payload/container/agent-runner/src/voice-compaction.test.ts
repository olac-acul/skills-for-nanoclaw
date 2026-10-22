import { describe, expect, it } from 'bun:test';

import { announceCompaction, COMPACTION_LINE, compactionStarted } from './voice-compaction.js';
import type { WriteMessageOut } from './db/messages-out.js';

const voiceRoute = { inReplyTo: 'voice-in-1', channelType: 'voice', platformId: 'voice:default', threadId: null };

function deps(route: typeof voiceRoute | null) {
  const written: WriteMessageOut[] = [];
  return { written, deps: { route: () => route, write: async (m: WriteMessageOut) => (written.push(m), written.length) } };
}

describe('compaction start', () => {
  it('is recognized in both kinds of OpenCode event', () => {
    expect(compactionStarted({ type: 'session.next.compaction.started', properties: { messageID: 'm1' } })).toBe('m1');
    expect(compactionStarted({ type: 'message.part.updated', properties: { part: { type: 'compaction', messageID: 'm2' } } })).toBe('m2');
  });

  it('is not seen in other events', () => {
    expect(compactionStarted({ type: 'message.part.updated', properties: { part: { type: 'text', messageID: 'm3' } } })).toBeNull();
    expect(compactionStarted({ type: 'session.compacted', properties: {} })).toBeNull();
    expect(compactionStarted(undefined)).toBeNull();
  });
});

describe('announcement', () => {
  it('tells the voice app once, as a working line tied to the request', async () => {
    const { written, deps: d } = deps(voiceRoute);
    const event = { type: 'message.part.updated', properties: { part: { type: 'compaction', messageID: 'a1' } } };
    expect(await announceCompaction(event, d)).toBe(true);
    expect(await announceCompaction(event, d)).toBe(false); // the same compaction again
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ in_reply_to: 'voice-in-1', channel_type: 'voice', platform_id: 'voice:default' });
    expect(JSON.parse(written[0]!.content)).toEqual({ text: COMPACTION_LINE, voice_working: true });
  });

  it('says nothing for a request from another channel, or with no request', async () => {
    const telegram = deps({ ...voiceRoute, channelType: 'telegram', platformId: 'telegram:1' });
    expect(await announceCompaction({ type: 'session.next.compaction.started', properties: { messageID: 'b1' } }, telegram.deps)).toBe(false);
    const none = deps(null);
    expect(await announceCompaction({ type: 'session.next.compaction.started', properties: { messageID: 'b2' } }, none.deps)).toBe(false);
    expect([...telegram.written, ...none.written]).toHaveLength(0);
  });

  it('never throws into the event loop', async () => {
    const failing = { route: () => voiceRoute, write: async () => { throw new Error('db gone'); } };
    expect(await announceCompaction({ type: 'session.next.compaction.started', properties: { messageID: 'c1' } }, failing)).toBe(false);
  });
});
