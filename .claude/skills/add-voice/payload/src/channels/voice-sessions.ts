/**
 * What the voice channel does to the agent's sessions of its chat: start a new conversation, and wake the agent's
 * container ahead of a request.
 */
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionForAgent } from '../db/sessions.js';
import { requestWake } from '../request-wake.js';
import { writeSessionMessage } from '../session-manager.js';

/**
 * "New conversation" from the app. The runner resets a session when it reads `/clear`, but the host's command gate
 * only lets admins send it, and the app's user is deliberately a plain member. So the adapter writes the `/clear`
 * itself, straight into this chat's sessions: it is fixed text from authenticated host code, never the user's words,
 * and it can only reset this chat's own conversation (memory and other chats are untouched). A wiring whose session
 * is shared with the agent's other channels is refused: clearing it would reset those conversations too.
 */
export async function clearVoiceConversation(
  chatId: string,
  clearId = `voice-clear-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
): Promise<number> {
  const mg = await getMessagingGroupByPlatform('voice', chatId);
  if (!mg) return 0;
  const wirings = await getMessagingGroupAgents(mg.id);
  const shared = wirings.filter((w) => (w as { session_mode?: string }).session_mode === 'agent-shared');
  if (shared.length > 0) throw new Error('the voice chat shares its session with other channels: not resetting it');
  let cleared = 0;
  for (const wiring of wirings) {
    const session = await findSessionForAgent(wiring.agent_group_id, mg.id, null);
    if (!session) continue; // no conversation yet: nothing to reset
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: clearId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: chatId,
      channelType: 'voice',
      threadId: null,
      content: JSON.stringify({ text: '/clear', sender: 'Voice', senderId: chatId }),
      trigger: true,
    });
    await requestWake(session, 'inbound-message');
    cleared++;
  }
  return cleared;
}

/**
 * The person is about to ask (tapped the orb, opened the assistant): start the agent's container now, so its start
 * overlaps the words being said. Only sessions that already exist; a running container is left as it is.
 */
export async function warmVoiceSessions(chatId: string): Promise<number> {
  const mg = await getMessagingGroupByPlatform('voice', chatId);
  if (!mg) return 0;
  let woken = 0;
  for (const wiring of await getMessagingGroupAgents(mg.id)) {
    const session = await findSessionForAgent(wiring.agent_group_id, mg.id, null);
    if (session && (await requestWake(session, 'interactive'))) woken++;
  }
  return woken;
}
