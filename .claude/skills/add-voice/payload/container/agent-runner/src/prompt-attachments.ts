import { isSessionEcho } from './formatter.js';
import type { MessageInRow } from './db/messages-in.js';
import type { PromptAttachment } from './providers/types.js';

/**
 * The files the host staged for a batch of messages, as the provider's
 * structured attachments: the formatter only names them in the prompt text, so
 * without this a model that can see images never receives one.
 *
 * Only files the host itself saved count: `localPath` must be exactly
 * `inbox/<message id>/<filename>` (what extractAttachmentFiles writes). Session
 * echoes are skipped, their files belong to another session's inbox. Providers
 * still decide what they forward (OpenCode: images and PDFs, size-capped, with
 * its own path checks).
 */
export function promptAttachments(messages: MessageInRow[]): PromptAttachment[] {
  const out: PromptAttachment[] = [];
  for (const msg of messages) {
    if (isSessionEcho(msg)) continue;
    let content: unknown;
    try {
      content = JSON.parse(msg.content);
    } catch {
      continue;
    }
    const attachments = (content as { attachments?: unknown } | null)?.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const att of attachments as Array<Record<string, unknown>>) {
      const localPath = att?.localPath;
      if (typeof localPath !== 'string') continue;
      const prefix = `inbox/${msg.id}/`;
      if (!localPath.startsWith(prefix)) continue;
      const filename = localPath.slice(prefix.length);
      if (!filename || filename.includes('/') || filename === '.' || filename === '..') continue;
      const mime = typeof att.mimeType === 'string' && att.mimeType ? att.mimeType : undefined;
      out.push({ sourceMessageId: msg.id, filename, path: `/workspace/${localPath}`, ...(mime ? { mime } : {}) });
    }
  }
  return out;
}
