#!/usr/bin/env node
/**
 * The voice channel needs two small seams in NanoClaw's core, which no skill directive can express as a copy
 * or an append:
 *
 *   reply pairing   the host passes the id of the message an agent was answering (`in_reply_to`) down to the
 *                   channel adapter, so the app can tie a reply, an action or "done" to the request it belongs to;
 *   attachments     the files the host staged for a turn (a photo from the app) reach the provider, which hands
 *                   them to the model (the OpenCode provider already reads `attachments`; the poll loop never
 *                   supplied them);
 *   availability    a tool may say when it is available (`available()`, asked at each listing); the MCP server lists
 *                   and runs only those: the phone tools exist only in the voice app's session, not in every
 *                   prompt of the other channels;
 *   summaries       when OpenCode summarizes a long conversation (auto-compaction), the voice app is told, the way
 *                   voice_working does (`voice-compaction.ts`). Optional: only where the OpenCode provider is
 *                   installed; skipped, not an error, without it.
 *
 * This script applies them as exact, anchored edits. It is built to fail loudly rather than guess:
 *
 *   - an edit is applied only when its anchor text occurs exactly once;
 *   - an edit already in place (its marker is present) is left alone, so running it again changes nothing;
 *   - if ANY edit of ANY file cannot be placed (the anchor moved, is gone, or occurs twice, because upstream
 *     changed that code), nothing is written at all and the script exits with a message naming the file and
 *     the edit, so the tree is never left half-patched.
 *
 *   node scripts/voice-core-seams.mjs          apply (default)
 *   node scripts/voice-core-seams.mjs --check  report only; exit 1 when an edit is missing or cannot be placed
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Each edit: `anchor` (exact text, once in the file), `replace` (the text that takes its place) and `marker`
 *  (text that is present only once the edit is applied). A file marked `optional` is left alone when it is absent. */
export const SEAMS = [
  {
    file: 'container/agent-runner/src/poll-loop.ts',
    edits: [
      {
        name: 'import promptAttachments',
        anchor: "import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';\n",
        replace:
          "import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';\nimport { promptAttachments } from './prompt-attachments.js';\n",
        marker: "import { promptAttachments } from './prompt-attachments.js';",
      },
      {
        name: 'attachments in the first query of a turn',
        anchor: '      systemContext: config.systemContext,\n',
        replace: '      systemContext: config.systemContext,\n      attachments: promptAttachments(keep),\n',
        marker: 'attachments: promptAttachments(keep),',
      },
      {
        name: 'attachments in a follow-up message',
        anchor: '        query.push(prompt);\n',
        replace: '        query.push(prompt, promptAttachments(keep));\n',
        marker: 'query.push(prompt, promptAttachments(keep));',
      },
    ],
  },
  {
    file: 'container/agent-runner/src/providers/types.ts',
    edits: [
      {
        name: 'QueryInput.attachments and PromptAttachment',
        anchor: '  systemContext?: {\n    instructions?: string;\n  };\n}\n',
        replace:
          '  systemContext?: {\n    instructions?: string;\n  };\n\n' +
          '  /** Files the host staged for these messages; providers that can hand media to the model use them. */\n' +
          '  attachments?: PromptAttachment[];\n}\n\n' +
          '/** A host-staged file, at `/workspace/inbox/<sourceMessageId>/<filename>`. */\n' +
          'export interface PromptAttachment {\n  sourceMessageId: string;\n  filename: string;\n  path: string;\n  mime?: string;\n}\n',
        marker: 'export interface PromptAttachment {',
      },
      {
        name: 'AgentQuery.push takes attachments',
        anchor: '  push(message: string): void;\n',
        replace: '  push(message: string, attachments?: PromptAttachment[]): void;\n',
        marker: 'push(message: string, attachments?: PromptAttachment[]): void;',
      },
    ],
  },
  {
    file: 'src/channels/adapter.ts',
    edits: [
      {
        name: 'OutboundMessage.inReplyTo',
        anchor: '  files?: OutboundFile[]; // file attachments from the session outbox\n',
        replace:
          '  files?: OutboundFile[]; // file attachments from the session outbox\n' +
          '  /** Id of the inbound message the agent was answering, when there was one; adapters that pair replies use it. */\n' +
          '  inReplyTo?: string | null;\n',
        marker: 'inReplyTo?: string | null;',
      },
    ],
  },
  {
    file: 'src/channels/channel-registry.ts',
    edits: [
      {
        name: 'delivery adapter takes inReplyTo',
        anchor: '      instance?: string,\n    ): Promise<string | undefined> {\n',
        replace: '      instance?: string,\n      inReplyTo?: string | null,\n    ): Promise<string | undefined> {\n',
        marker: '      inReplyTo?: string | null,\n    ): Promise<string | undefined> {',
      },
      {
        name: 'inReplyTo handed to the adapter',
        anchor: 'return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });',
        replace: 'return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files, inReplyTo });',
        marker: 'content: JSON.parse(content), files, inReplyTo }',
      },
    ],
  },
  {
    file: 'container/agent-runner/src/mcp-tools/types.ts',
    edits: [
      {
        name: 'McpToolDefinition.available',
        anchor: '  handler: (args: Record<string, unknown>, context?: { signal: AbortSignal }) => Promise<CallToolResult>;\n}\n',
        replace:
          '  handler: (args: Record<string, unknown>, context?: { signal: AbortSignal }) => Promise<CallToolResult>;\n' +
          '  /** False: the tool is neither listed nor runnable now. Asked at each listing, when the session is known. */\n' +
          '  available?: () => boolean;\n}\n',
        marker: 'available?: () => boolean;',
      },
    ],
  },
  {
    file: 'container/agent-runner/src/mcp-tools/server.ts',
    edits: [
      {
        name: 'only available tools are listed',
        anchor: '    tools: allTools.map((t) => t.tool),\n',
        replace: '    tools: allTools.filter((t) => t.available?.() ?? true).map((t) => t.tool),\n',
        marker: 'allTools.filter((t) => t.available?.() ?? true)',
      },
      {
        name: 'an unavailable tool is not run',
        anchor: '    const tool = toolMap.get(name);\n    if (!tool) {\n',
        replace: '    const tool = toolMap.get(name);\n    if (!tool || tool.available?.() === false) {\n',
        marker: 'if (!tool || tool.available?.() === false) {',
      },
    ],
  },
  {
    file: 'container/agent-runner/src/providers/opencode-turn.ts',
    optional: true,
    edits: [
      {
        name: 'import announceCompaction',
        anchor: "import { randomBytes } from 'crypto';\n",
        replace: "import { randomBytes } from 'crypto';\n\nimport { announceCompaction } from '../voice-compaction.js';\n",
        marker: "import { announceCompaction } from '../voice-compaction.js';",
      },
      {
        name: 'every event of the turn passes by the compaction announcement',
        anchor: '    if (!pump.belongsTo(record.sessionID, sessionId)) return;\n',
        replace:
          '    if (!pump.belongsTo(record.sessionID, sessionId)) return;\n    void announceCompaction(event); // the voice app shows that the conversation is being summarized\n',
        marker: 'void announceCompaction(event);',
      },
    ],
  },
  {
    file: 'src/delivery.ts',
    edits: [
      {
        name: 'ChannelDeliveryAdapter.deliver takes inReplyTo',
        anchor: '    instance?: string,\n  ): Promise<string | undefined>;\n',
        replace:
          '    instance?: string,\n    /** The inbound message the agent was answering (messages_out.in_reply_to). */\n' +
          '    inReplyTo?: string | null,\n  ): Promise<string | undefined>;\n',
        marker: '    inReplyTo?: string | null,\n  ): Promise<string | undefined>;',
      },
      {
        name: 'inReplyTo passed on delivery',
        anchor: '    deliverInstance,\n',
        replace: '    deliverInstance,\n    msg.inReplyTo,\n',
        marker: '    msg.inReplyTo,\n',
      },
    ],
  },
];

const count = (text, needle) => (needle === '' ? 0 : text.split(needle).length - 1);

/**
 * Work out every file's new content without writing anything.
 * Returns `{ files: [{file, content, changed}], problems: [string] }`.
 */
export function plan(root, seams = SEAMS) {
  const files = [];
  const problems = [];
  for (const { file, edits, optional } of seams) {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) {
      if (!optional) problems.push(`${file}: file not found (is this a NanoClaw install?)`);
      continue;
    }
    let content = fs.readFileSync(full, 'utf8');
    let changed = false;
    for (const edit of edits) {
      if (content.includes(edit.marker)) continue; // already in place
      const found = count(content, edit.anchor);
      if (found !== 1) {
        problems.push(
          `${file}: cannot place "${edit.name}": its anchor text occurs ${found} time(s), expected exactly 1. ` +
            'Upstream changed this code; the edit must be reviewed by hand.',
        );
        continue;
      }
      content = content.replace(edit.anchor, () => edit.replace);
      changed = true;
    }
    files.push({ file, content, changed });
  }
  return { files, problems };
}

/** Apply every edit, or none. Returns the files written. */
export function apply(root, seams = SEAMS) {
  const { files, problems } = plan(root, seams);
  if (problems.length > 0) {
    const error = new Error(problems.join('\n'));
    error.problems = problems;
    throw error;
  }
  const written = [];
  for (const { file, content, changed } of files) {
    if (!changed) continue;
    const full = path.join(root, file);
    const temp = `${full}.seams-tmp`;
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, full);
    written.push(file);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const checkOnly = process.argv.includes('--check');
  try {
    if (checkOnly) {
      const { files, problems } = plan(root);
      if (problems.length > 0) throw Object.assign(new Error(problems.join('\n')), { problems });
      const missing = files.filter((f) => f.changed).map((f) => f.file);
      if (missing.length > 0) {
        console.log(`voice core seams: not applied yet in ${missing.join(', ')}`);
        process.exit(1);
      }
      console.log('voice core seams: all in place');
    } else {
      const written = apply(root);
      console.log(written.length > 0 ? `voice core seams: applied to ${written.join(', ')}` : 'voice core seams: already in place');
    }
  } catch (error) {
    console.error('voice core seams: NOTHING WAS CHANGED.\n' + error.message);
    console.error(
      '\nThe NanoClaw code these edits attach to has changed. Update this skill (or open an issue) rather than editing by hand.',
    );
    process.exit(2);
  }
}
