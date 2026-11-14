---
name: add-signal-number
description: Signal channel with a number of its own (a SIM or a landline only the assistant uses) instead of the owner's linked phone. Pictures and PDFs reach the agent as copies in its session, never as paths; signal-cli's files are removed; only the allowed groups and the owner's direct messages get through.
---

# Signal with a number of its own

Upstream's `add-signal` links NanoClaw to the owner's phone as a secondary device: the assistant then writes as the
owner, and signal-cli on the server receives and decrypts every chat of the owner. This skill uses the same native
adapter (a JSON-RPC client of the signal-cli daemon) with a number registered for the assistant alone: it is a member
of the groups it serves, under its own name, and sees nothing else.

The adapter is `src/channels/signal-number.ts` (the channel is still `signal`). The file has its own name on purpose:
NanoClaw's updater refreshes every channel whose import is in the barrel from the skill named after it, so an
`import './signal.js'` would be refreshed from upstream's `add-signal`, which would put upstream's adapter back over
this one at every update. Do not install this skill and upstream's `add-signal` together: both register `signal`.

What changes from upstream's adapter:

- **Attachments as copies.** Pictures (JPEG, PNG, WebP) and PDFs, up to 10 MB each and four per message, go to the
  agent with their bytes: the host saves a copy in the session's own inbox. Upstream passed a path into signal-cli's
  folder, which the container cannot read and which holds every chat's files. Anything not passed on is said in the
  text ("type … is not read", "larger than 10 MB").
- **No file kept.** Every message's files are deleted from signal-cli's folder once it is handled or dropped, and a
  sweep every ten minutes removes what is older than an hour (a message received while nothing handled it).
- **Only who is allowed.** `SIGNAL_DM_ALLOW` (numbers, comma separated): direct messages only from them.
  `SIGNAL_GROUP_ALLOW` (group ids): only these groups. Anything else is ignored before it reaches NanoClaw: no chat is
  created, nobody is woken. Unset, they filter nothing (the router's own sender policy still applies).
- **The profile is left alone.** Upstream renamed the account "NanoClaw" at every start; here only when
  `SIGNAL_PROFILE_NAME` is set. The name is given at registration.
- **Fewer personal details in the logs**: no paths, numbers or names of senders.

## Prerequisites

- A NanoClaw install, version 2.4 or later.
- A number for the assistant that can receive an SMS (or a call: `--voice`). Free VoIP numbers are often refused by
  Signal. Do not use Signal on that number from a phone too: the assistant's registration would end. Keep the SIM
  active: Signal may ask to verify it again.
- The same number must never be served from two machines at once: stop it on one before starting it on the other.

## Install

```nc:copy
payload/scripts/signal-register.sh -> scripts/signal-register.sh
payload/setup/install-signal-cli.sh -> setup/install-signal-cli.sh
payload/src/channels/signal-number-registration.test.ts -> src/channels/signal-number-registration.test.ts
payload/src/channels/signal-number.test.ts -> src/channels/signal-number.test.ts
payload/src/channels/signal-number.ts -> src/channels/signal-number.ts
```

signal-cli, the native build pinned by version and SHA-256 (no Java), into `~/.local/bin` when it is not there:

```nc:run effect:external
command -v signal-cli >/dev/null 2>&1 || [ -x "$HOME/.local/bin/signal-cli" ] || bash setup/install-signal-cli.sh
```

Register the channel (one import line in the channel barrel):

```nc:append to:src/channels/index.ts
import './signal-number.js';
```

Build and run the tests (the adapter's, and the registration test that fails if the import line is missing):

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/signal-number
```

The channel starts only when `SIGNAL_ACCOUNT` is set: installing the skill changes nothing until the number is
registered.

## Register the number

As the NanoClaw user, from the NanoClaw folder, in a real terminal (it asks for Signal's captcha, the code and a PIN):

```bash
bash scripts/signal-register.sh --number +39... --name "Alfred" --owner +39...
```

It registers the number, sets a registration lock PIN (asked twice, never stored: without it nobody can register the
number elsewhere; keep it somewhere safe) and the profile name, and writes `SIGNAL_ACCOUNT` and `SIGNAL_DM_ALLOW`
(the owner's number) in `.env`. signal-cli's data, which holds the account's keys, stays in
`~/.local/share/signal-cli` (mode 0700): back it up with the server, never into git.

## Wire a group

1. From a phone, add the assistant's number to the group.
2. Find the group's id: stop NanoClaw (signal-cli serves one process per account), run
   `signal-cli -a <number> receive` once (it takes the invitation) and `signal-cli -a <number> listGroups`.
3. Put the id in `SIGNAL_GROUP_ALLOW` in `.env` (comma separated for more groups) and start NanoClaw again.
4. Create the messaging group and wire it to its agent (see `ncl messaging-groups help` and `ncl wirings help`):

```bash
ncl messaging-groups create --channel-type signal --platform-id "group:<id>" --name "<name>" --is-group 1
ncl wirings create --messaging-group-id <mg-id> --agent-group-id <ag-id>
```

In groups the assistant answers only when mentioned, and unknown senders are refused (`strict`): approve each member
of the group once, as NanoClaw's sender approval asks. Several groups can be wired to different agents on the same
number: each agent keeps its own folder, memory and sessions.

## Check

- A direct message from the owner gets an answer; one from any other number is ignored.
- In the group: an answer only when mentioned; a picture and a PDF reach the agent (it can describe them), and
  `~/.local/share/signal-cli/attachments` is empty afterwards.
- A message in another group the number is in is ignored.
