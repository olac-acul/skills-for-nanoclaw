# Remove the voice channel

Reverses what the skill added. The wiring rows and the sender are your runtime data: `ncl` shows how to delete them.

1. Turn the channel off and take the instructions section out of the group: `pnpm exec tsx scripts/voice-setup.ts disable`, then restart NanoClaw.
2. Delete the two registration lines (delete them, do not comment them out):
   - `import './voice.js';` from `src/channels/index.ts`
   - `import './phone.js';` from `container/agent-runner/src/mcp-tools/index.ts`
3. Before deleting any file, undo the core edits that import the skill's files, or no agent container starts any more (a module would be missing). Revert these with `git checkout <file>` if your tree was clean when they were applied (`node scripts/voice-core-seams.mjs --check` lists what is in place):
   - `container/agent-runner/src/poll-loop.ts`, which imports `prompt-attachments.ts`;
   - `container/agent-runner/src/providers/opencode-turn.ts`, which imports `voice-compaction.ts` (OpenCode only);
   - `container/agent-runner/src/providers/opencode-config.ts`, which imports `voice-instructions-filter.ts` (OpenCode only; if the assistant prompt skill is installed, put its edit back afterwards with `node scripts/assistant-prompt-seams.mjs`).
4. Delete the copied files:

```text files
container/agent-runner/src/mcp-tools/phone.test.ts
container/agent-runner/src/mcp-tools/phone.ts
container/agent-runner/src/mcp-tools/weather.test.ts
container/agent-runner/src/mcp-tools/weather.ts
container/agent-runner/src/prompt-attachments.test.ts
container/agent-runner/src/prompt-attachments.ts
container/agent-runner/src/voice-compaction.test.ts
container/agent-runner/src/voice-compaction.ts
container/agent-runner/src/voice-instructions-filter.test.ts
container/agent-runner/src/voice-instructions-filter.ts
scripts/tsconfig.voice-setup.json
scripts/voice-core-seams.mjs
scripts/voice-setup.ts
src/channels/voice-install.test.ts
src/channels/voice-install.ts
src/channels/voice-instructions.md
src/channels/voice-registration.test.ts
src/channels/voice-reset.test.ts
src/channels/voice.test.ts
src/channels/voice.ts
```

5. Uninstall the dependencies if nothing else uses them: `pnpm remove ws @types/ws`.
6. The other core changes import nothing of the skill and are harmless without the channel, so they can stay: `in_reply_to` through `src/delivery.ts`, `src/channels/adapter.ts` and `src/channels/channel-registry.ts`; the attachments type in `container/agent-runner/src/providers/types.ts`; the tool availability in `container/agent-runner/src/mcp-tools/types.ts` and `server.ts` (it does nothing without a tool that uses it). To take them out too, revert those six files the same way.
7. Remove `VOICE_ENABLED`, `VOICE_AUTH_TOKEN`, `VOICE_BIND_HOST`, `VOICE_CHANNEL_PORT`, `VOICE_IDLE_RESET_MINUTES` (if you set it) and `OPENCODE_MODEL_INPUT_MODALITIES` (if you set it for photos) from `.env`, and delete `data/voice-push.json`, `data/voice-activity.json`, `data/voice-status.json` and `data/voice-pairing.json`.
8. Remove the wiring: `ncl wirings delete` and `ncl messaging-groups delete` for the `voice` channel, the user `voice:default`, and `groups/voice/` if it was made for this channel.
9. `pnpm run build`, commit the removal, then `pnpm exec tsx scripts/upgrade-state.ts set` (NanoClaw checks that record against the last commit at every start) and restart the service.
