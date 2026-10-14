import { describe, expect, it } from 'bun:test';

import { getPendingMessages, type MessageInRow } from './db/messages-in.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { promptAttachments } from './prompt-attachments.js';

function row(id: string, content: unknown, channelType = 'telegram'): MessageInRow {
  return {
    id,
    seq: 1,
    kind: 'chat',
    timestamp: '2026-10-13T10:00:00.000Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id: 'p',
    channel_type: channelType,
    thread_id: null,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    source_session_id: null,
    on_wake: 0,
  };
}

describe('promptAttachments', () => {
  it('turns host-staged files into structured attachments', () => {
    const msgs = [
      row('m1', {
        text: 'cosa vedi?',
        attachments: [{ type: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', localPath: 'inbox/m1/photo.jpg' }],
      }),
    ];
    expect(promptAttachments(msgs)).toEqual([
      { sourceMessageId: 'm1', filename: 'photo.jpg', path: '/workspace/inbox/m1/photo.jpg', mime: 'image/jpeg' },
    ]);
  });

  it('keeps the attachments of every message in the batch, without a mime when none was given', () => {
    const msgs = [
      row('m1', { text: 'a', attachments: [{ localPath: 'inbox/m1/a.png' }] }),
      row('m2', { text: 'b' }),
      row('m3', { text: 'c', attachments: [{ localPath: 'inbox/m3/c.webp', mimeType: '' }] }),
    ];
    expect(promptAttachments(msgs)).toEqual([
      { sourceMessageId: 'm1', filename: 'a.png', path: '/workspace/inbox/m1/a.png' },
      { sourceMessageId: 'm3', filename: 'c.webp', path: '/workspace/inbox/m3/c.webp' },
    ]);
  });

  it('ignores files the host did not stage for that message', () => {
    const msgs = [
      row('m1', {
        attachments: [
          { name: 'remote.jpg', url: 'https://example.test/remote.jpg' },
          { localPath: 'inbox/other/x.jpg' },
          { localPath: 'inbox/m1/../m2/x.jpg' },
          { localPath: 'inbox/m1/' },
          { localPath: '/etc/passwd' },
        ],
      }),
    ];
    expect(promptAttachments(msgs)).toEqual([]);
  });

  it('reads the rows the poll loop gets from the inbound mailbox', () => {
    initTestSessionDb();
    try {
      // The shape session-manager's extractAttachmentFiles leaves after saving the bytes.
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
           VALUES ('msg-7', 'chat', datetime('now'), 'pending', NULL, 1, 0, ?)`,
        )
        .run(
          JSON.stringify({
            sender: 'User',
            text: 'cosa vedi?',
            attachments: [
              { type: 'image', name: 'photo.jpg', mimeType: 'image/jpeg', localPath: 'inbox/msg-7/photo.jpg' },
            ],
          }),
        );
      expect(promptAttachments(getPendingMessages())).toEqual([
        {
          sourceMessageId: 'msg-7',
          filename: 'photo.jpg',
          path: '/workspace/inbox/msg-7/photo.jpg',
          mime: 'image/jpeg',
        },
      ]);
    } finally {
      closeSessionDb();
    }
  });

  it('skips session echoes and content that is not JSON', () => {
    const msgs = [
      row('m1', { attachments: [{ localPath: 'inbox/m1/a.jpg' }] }, 'session-echo'),
      row('m2', 'plain text'),
      row('m3', 'null'),
    ];
    expect(promptAttachments(msgs)).toEqual([]);
  });
});
