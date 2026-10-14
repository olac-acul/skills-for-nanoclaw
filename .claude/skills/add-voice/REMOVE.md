# Remove the voice channel

Reverses what the skill added. The wiring rows and the sender are your runtime data: `ncl` shows how to delete them.

1. Turn the channel off and take the instructions section out of the group: `pnpm exec tsx scripts/voice-setup.ts disable`, then restart NanoClaw.
2. Delete the two registration lines (delete them, do not comment them out):
   - `import './voice.js';` from `src/channels/index.ts`
   - `import './phone.js';` from `container/agent-runner/src/mcp-tools/index.ts`
3. Delete the copied files:

```text files
container/agent-runner/src/mcp-tools/phone.test.ts
container/agent-runner/src/mcp-tools/phone.ts
container/agent-runner/src/prompt-attachments.test.ts
container/agent-runner/src/prompt-attachments.ts
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

4. Uninstall the dependencies if nothing else uses them: `pnpm remove ws @types/ws`.
5. The two core changes (`in_reply_to` through `delivery.ts`, `adapter.ts` and `channel-registry.ts`; attachments through `poll-loop.ts` and `providers/types.ts`) are harmless without the channel and can stay. To take them out, revert those five files with `git checkout` if your tree was clean when they were applied.
6. Remove `VOICE_ENABLED`, `VOICE_AUTH_TOKEN`, `VOICE_BIND_HOST`, `VOICE_CHANNEL_PORT` and `OPENCODE_MODEL_INPUT_MODALITIES` (if you set it for photos) from `.env`, and delete `data/voice-push.json`.
7. Remove the wiring: `ncl wirings delete` and `ncl messaging-groups delete` for the `voice` channel, the user `voice:default`, and `groups/voice/` if it was made for this channel.
8. `pnpm run build` and restart the service.
