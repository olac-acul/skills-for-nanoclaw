---
name: add-voice
description: Voice channel for the NanoVoice Android app. A WebSocket endpoint with a bearer token that streams the agent's replies to the phone and lets the agent run phone actions (timers, alarms, apps, calendar with approval, music, notes, photos). Includes the phone tools, the voice-style instructions, photo support and a setup script.
---

# Voice channel (NanoVoice)

Adds a native WebSocket channel for the [NanoVoice](https://github.com/olac-acul/nanovoice) Android app (protocol version 1, described in that repository's `docs/PROTOCOL.md`). One app connection at a time; a bearer token is mandatory. No external service: the phone reaches the install directly, best through a VPN (Tailscale or WireGuard) or a private network.

What it adds:

- **The channel** (`src/channels/voice.ts`): replies, actions, "working" and "done" tied to the app request they belong to; a single checked photo per message; wake-up push through UnifiedPush for a phone that is off; "new conversation" and "warm-up" frames.
- **Weather** for the voice app's conversation (`weather_forecast`): Italian places from 3B Meteo's page, places abroad (and Italian ones when 3B Meteo does not answer or its page cannot be read) from Open-Meteo, a few lines with the source. One tool call instead of a web search and several reads of a page too large to fit. Other channels are not affected.
- **Phone tools** for the agent (`phone_set_timer`, `phone_set_alarm`, stopping, skipping and snoozing them, `phone_open_app`, `phone_call`, music, volume, flashlight, navigation, links, message and Signal drafts, notes, battery, reads of the calendar, position and notifications, calendar changes with approval on the phone, photo tools, `voice_working`). They exist in every agent container and fail with a clear message unless the session has a voice channel.
- **Instructions** for the agent in the style of speech (short answers, numbers as digits, no private details read aloud), as one section between markers in the group's `instructions.prepend.md`, replaced as a whole on update.
- **Two small changes to NanoClaw's core**, made by `scripts/voice-core-seams.mjs`: the id of the message an agent answers reaches the channel adapter, and the files the host staged for a turn (a photo) reach the provider. They are exact, anchored edits; if upstream changes that code the script changes nothing and says which edit no longer fits (see *Updating NanoClaw*).
- **`scripts/voice-setup.ts`** to enable the channel, wire it to an agent and show what to enter in the app.

## Prerequisites

- A NanoClaw install, version 2.4 or later, whose agents use a provider that can pass images to the model for the photo features (the upstream OpenCode provider does; see *Photos*).
- Node and pnpm as NanoClaw itself needs.

## Install

```nc:run effect:check
node -e "const fs=require('fs');const need=[['src/channels/index.ts','import'],['container/agent-runner/src/mcp-tools/index.ts','import'],['src/delivery.ts','deliverInstance'],['setup/register.ts','getAgentGroupByFolder']];process.exit(need.every(([f,s])=>fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes(s))?0:1)"
```

If that check fails, this is not a NanoClaw install this skill fits: update NanoClaw (`/update-nanoclaw`) or use a newer version of the skill.

```nc:copy
payload/container/agent-runner/src/mcp-tools/phone.test.ts -> container/agent-runner/src/mcp-tools/phone.test.ts
payload/container/agent-runner/src/mcp-tools/phone.ts -> container/agent-runner/src/mcp-tools/phone.ts
payload/container/agent-runner/src/mcp-tools/weather.test.ts -> container/agent-runner/src/mcp-tools/weather.test.ts
payload/container/agent-runner/src/mcp-tools/weather.ts -> container/agent-runner/src/mcp-tools/weather.ts
payload/container/agent-runner/src/prompt-attachments.test.ts -> container/agent-runner/src/prompt-attachments.test.ts
payload/container/agent-runner/src/prompt-attachments.ts -> container/agent-runner/src/prompt-attachments.ts
payload/container/agent-runner/src/voice-compaction.test.ts -> container/agent-runner/src/voice-compaction.test.ts
payload/container/agent-runner/src/voice-compaction.ts -> container/agent-runner/src/voice-compaction.ts
payload/container/agent-runner/src/voice-instructions-filter.test.ts -> container/agent-runner/src/voice-instructions-filter.test.ts
payload/container/agent-runner/src/voice-instructions-filter.ts -> container/agent-runner/src/voice-instructions-filter.ts
payload/scripts/tsconfig.voice-setup.json -> scripts/tsconfig.voice-setup.json
payload/scripts/voice-core-seams.mjs -> scripts/voice-core-seams.mjs
payload/scripts/voice-setup.ts -> scripts/voice-setup.ts
payload/src/channels/voice-install.test.ts -> src/channels/voice-install.test.ts
payload/src/channels/voice-install.ts -> src/channels/voice-install.ts
payload/src/channels/voice-instructions.md -> src/channels/voice-instructions.md
payload/src/channels/voice-registration.test.ts -> src/channels/voice-registration.test.ts
payload/src/channels/voice-reset.test.ts -> src/channels/voice-reset.test.ts
payload/src/channels/voice.test.ts -> src/channels/voice.test.ts
payload/src/channels/voice.ts -> src/channels/voice.ts
```

The WebSocket library, pinned:

```nc:dep
ws@8.21.3
@types/ws@8.18.1
```

The core changes: three always (replies tied to the request; host-staged photos reaching the provider; tools that say when they are available, so the phone tools are offered only in the voice app's conversation and not in every Telegram or terminal prompt), and two where the OpenCode provider is installed: the voice section of the instructions only in the voice app's conversation, and telling the app when OpenCode summarizes a long conversation (it shows and says "Riassumo la conversazione...", like a web search). This is idempotent: run again after an update of NanoClaw, it does nothing when the changes are in place and stops without writing anything if the code they attach to has moved.

```nc:run effect:refresh
node scripts/voice-core-seams.mjs
```

Register the channel and the phone tools (one import line in each of two existing barrels):

```nc:append to:src/channels/index.ts
import './voice.js';
```

```nc:append to:container/agent-runner/src/mcp-tools/index.ts
import './phone.js';
```

Build, typecheck the setup script and run the tests. `voice-registration.test.ts` imports the real barrel and fails if the import line is removed, the barrel does not evaluate or `ws` is missing; `voice.test.ts` drives the real adapter with a real WebSocket client (authentication, handshake, streaming, action round trip, capability filtering, notifications, photos, push).

```nc:run effect:build
pnpm run build
```

```nc:run effect:build
pnpm exec tsc -p scripts/tsconfig.voice-setup.json
```

```nc:run effect:test
pnpm exec vitest run src/channels/voice
```

```nc:run effect:test
(cd container/agent-runner && bun install --frozen-lockfile && bun test src/mcp-tools/phone.test.ts src/mcp-tools/weather.test.ts src/prompt-attachments.test.ts src/voice-compaction.test.ts src/voice-instructions-filter.test.ts)
```

## Enable

```bash
pnpm exec tsx scripts/voice-setup.ts enable --bind <address the phone reaches>
```

It writes `VOICE_ENABLED`, `VOICE_AUTH_TOKEN` (a new random token, shown once; `pair` shows it again), `VOICE_BIND_HOST` and `VOICE_CHANNEL_PORT` (8767) in `.env`, and puts the voice instructions into the agent's group. Choose the address with care: it is the one the channel listens on.

- Use the address of a **VPN or private network** that the phone is on. The app accepts a plain `ws://` address only inside a private network with a VPN up, and requires `wss://` for anything else.
- `127.0.0.1` (the default) listens on this machine only. `0.0.0.0` listens on every address: do not use it on a machine that faces the internet.
- Behind a TLS reverse proxy keep the channel on a private address and give the app the proxy's `wss://` address.

### Which agent answers

- **An agent you already have (the default)** — `--folder <group folder>`, or no flag when there is only one group. The app talks to the same agent as your other channels: shared memory and tools, separate conversations. Anyone holding the token reaches that agent, so treat the token like a password.
- **A separate agent** — `--dedicated` makes a group `voice` for the app alone. It does not see the other agents' memory or tools, which limits the damage of a leaked token. You can still share another group's memory with it, read-only (see below).

## Wire the channel

Restart NanoClaw so the host loads the channel, then:

```bash
pnpm exec tsx scripts/voice-setup.ts wire            # add --dedicated or --folder <name> as in `enable`
```

It registers the messaging group `voice:default`, wires it to the agent (one shared session), creates the sender `voice:default` as a plain member (not an administrator: an administrator could also approve the agent's requests from the phone), and the agent introduces itself in the app's first conversation.

## Pair the app

```bash
pnpm exec tsx scripts/voice-setup.ts pair
```

prints the address and the token to enter in the app (Settings, NanoClaw server). With the manager panel installed there is an easier way: its **Phone** page shows a QR code (after you confirm your password) that the app scans in Settings, NanoClaw server. The code is one-time and lasts five minutes; it is not the token. The voice channel answers the exchange on `POST /pair` at its own address (the code's hash is left by the panel in `data/voice-pairing.json`). Pass `--address <host>` when the phone reaches the machine under another name than the one it listens on.

## Verify

1. In the app, send a message: the reply streams into the chat.
2. Ask: "fai partire sul mio telefono un conto alla rovescia di tre minuti" (the app's local router does not catch this phrasing): the agent calls `phone_set_timer` and the Clock app starts a timer.
3. Ask: "potresti aprirmi l'app Signal per favore": the phone opens the app.

## Photos

A photo sent from the app reaches the model only if the provider passes images on and the model understands them. With the OpenCode provider set `OPENCODE_MODEL_INPUT_MODALITIES=image` in `.env` when the model accepts images, and remove it when it does not (a model that cannot see the photo would otherwise answer without it). The model chosen in the manager panel does not change this key.

## Slow requests, new conversation, push

- `voice_working` writes a line ending in `[[working]]` to the voice channel. The adapter strips the marker, sends a `working` frame and keeps the reply open (up to 3 minutes) instead of closing it after 1.5 s of silence, so the answer arrives in the same reply.
- The app's "new conversation" sends `new_conversation`. The host keeps `/clear` for administrators and the voice sender is a plain member on purpose, so the adapter writes a fixed `/clear` row into this chat's own sessions and wakes them; other chats and the memory are untouched.
- **A long pause starts a new conversation by itself.** A message that comes after 30 minutes without any message either way first resets the conversation the same way, so the agent answers on a short context (a conversation kept for days makes every request reread it, and a lost prompt cache costs tens of seconds). Memory and other chats are untouched; the app keeps showing the old messages, but the agent no longer has them in mind. Change the pause with `VOICE_IDLE_RESET_MINUTES` in `.env` (minutes; `0` turns it off) and restart NanoClaw. The time of the last message is kept in `data/voice-activity.json`.
- When the app registers with a UnifiedPush distributor the adapter keeps the URL in `data/voice-push.json` (mode 600) and, for a message that arrives while the phone is offline, POSTs the body `wake` to it (at most every 15 s). The body never holds the message: the app wakes, reconnects and receives what was queued. The install needs outbound HTTPS to the distributor (for example ntfy.sh).

## Optional: let the voice agent read another group's memory

Only for `--dedicated`. Each group keeps its own `memory/`. To share one read-only, name only that folder in `~/.config/nanoclaw/mount-allowlist.json` (mode 600, read-only), then:

```bash
ncl groups config add-mount --id <voice group id> --host <install>/groups/<other folder>/memory --container other-memory --ro
ncl groups restart --id <voice group id>
```

Everything in that memory becomes readable by the voice channel, so share only what you are happy to hear spoken.

## Updating NanoClaw

After `/update-nanoclaw` run `node scripts/voice-core-seams.mjs`: it is a no-op when the two core changes are still in place. If upstream rewrote the code they attach to, it prints which edit no longer fits and **changes nothing**; the voice channel then keeps working with the version already built, but a rebuild would fail the typecheck. In that case update this skill. The repository's nightly job applies the skill to upstream's `main` and reports it before you meet it.

## Troubleshooting

- **401 on connect** — the token in the app differs from `VOICE_AUTH_TOKEN` (`pair` shows the right one).
- **Connects, no reply** — the channel is not wired or the sender is not a member: run `wire` again.
- **"hello required first"** — the client must send `hello` (protocol 1) first.
- **The app says it needs a VPN** — a plain `ws://` address is accepted only on a private network with a VPN up; use `wss://` otherwise.
- **Replies split into several `done`s** — the host delivers whole messages, so `done` follows 1.5 s of silence; a very slow multi-step answer can be cut in two.
- **`voice core seams: NOTHING WAS CHANGED`** — upstream changed the code the edits attach to; see *Updating NanoClaw*.
