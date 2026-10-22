/**
 * OpenCode summarizes a long conversation by itself (auto-compaction). That takes a while, with nothing said: when the
 * request being answered came from the voice app, the app is told, the same way as with voice_working's "Cerco sul
 * Web...": a short line it shows animated and speaks, and the reply stays open for the answer.
 *
 * Called with every OpenCode event of the session (a seam in the OpenCode provider, see scripts/voice-core-seams.mjs).
 * It never throws into the caller and tells the app once per request: OpenCode can start several compactions while
 * answering one (it starts another when the summary is still too long), and the app needs to hear it only once.
 */
import { writeMessageOut, type WriteMessageOut } from './db/messages-out.js';
import { getCurrentReplyRoute, type ReplyRoute } from './db/session-state.js';

export const COMPACTION_LINE = 'Riassumo la conversazione...';

interface CompactionEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/** The id of the compaction an event starts, or null when it does not start one. */
export function compactionStarted(event: CompactionEvent | undefined): string | null {
  if (!event) return null;
  const properties = (event.properties ?? {}) as Record<string, unknown>;
  if (event.type === 'session.next.compaction.started') {
    return typeof properties.messageID === 'string' ? properties.messageID : 'compaction';
  }
  if (event.type === 'message.part.updated') {
    const part = properties.part as { type?: unknown; messageID?: unknown } | undefined;
    if (part?.type === 'compaction') return typeof part.messageID === 'string' ? part.messageID : 'compaction';
  }
  return null;
}

export interface CompactionDeps {
  route: () => ReplyRoute | null;
  write: (message: WriteMessageOut) => Promise<number>;
}

/** The requests whose summary was already announced (the latest ones). */
const announced = new Set<string>();

/** Tells the voice app that the conversation is being summarized. True when a line was written. */
export async function announceCompaction(
  event: CompactionEvent | undefined,
  deps: CompactionDeps = { route: getCurrentReplyRoute, write: writeMessageOut },
): Promise<boolean> {
  try {
    if (!compactionStarted(event)) return false;
    const route = deps.route();
    if (!route || route.channelType !== 'voice' || !route.platformId) return false;
    if (announced.has(route.inReplyTo)) return false;
    announced.add(route.inReplyTo);
    if (announced.size > 50) announced.delete(announced.values().next().value as string);
    await deps.write({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      in_reply_to: route.inReplyTo,
      kind: 'chat',
      platform_id: route.platformId,
      channel_type: 'voice',
      thread_id: route.threadId ?? null,
      content: JSON.stringify({ text: COMPACTION_LINE, voice_working: true }),
    });
    console.error('[voice] the conversation is being summarized: the app was told');
    return true;
  } catch (error) {
    console.error(`[voice] could not tell the app about the summary: ${String(error).slice(0, 200)}`);
    return false;
  }
}
