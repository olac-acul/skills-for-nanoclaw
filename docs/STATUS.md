# Project status

What works, what has been tested, and what is known to be missing. Updated when something changes.

## What it does

Four skills for a clean upstream NanoClaw install, without a fork and without a Compose stack of their own:

- **`add-manager-panel`**: a web panel (overview, agents, the model provider for all agents, provider
  credentials, backups, a built-in guide).
- **`add-manager-backup`**: encrypted, verified backups and restores, with rollback, a rehearsal mode,
  and weekly scheduled backups with a retention count.
- **`add-voice`**: a voice channel for the NanoVoice Android app, with phone tools, choices, weather and photos.
- **`add-assistant-prompt`**: a short assistant prompt for OpenCode agents in place of OpenCode's coding prompt.

Model access itself comes from upstream's OpenCode provider (`/add-opencode`) and the credential gateway
from upstream's OneCLI skill; the panel configures them, it does not replace them.

## Design decisions

- A repository of skills only; no fork of upstream. Updates go through upstream's transactional updater, driven by
  `scripts/update-install.mjs`, which also refreshes the installed skills and checks their core edits.
- Upstream's credential gateway (OneCLI) at upstream's pin. Gateway credentials are **not** part of a backup
  and are entered again after a restore; a restore lists the credential names to re-enter.
- One provider for all agents (an OpenAI-compatible endpoint, ChatGPT, or Claude); a different provider per
  agent is not offered.
- Panel reachable from localhost and, if you choose, the local network; HTTPS is optional and configured by
  the operator. Default bind is localhost. UI language: English, with the strings in one file.
- Backups from the panel wait a limited time for agents that are mid-message and then go ahead, recording
  whether the copy was `quiescent` or `best-effort`. Restores run from the terminal with the service stopped.
- Scheduled backups use one key of their own, kept in a private file; each manual backup has its own key shown
  once.

## Tested

- Applies with upstream's own skill engine to a clean checkout and passes upstream's build and the skills'
  tests; a nightly workflow repeats this against upstream `main`, then takes the composed tree through
  `update-install.mjs` (a clean merge and a conflict) against a local stand-in for a newer upstream.
- On real installs (Debian 13, Docker, OneCLI, OpenCode): panel and first-run setup, model and provider
  changes with rollback, ChatGPT subscription login and API key, Claude credential, removal of credentials,
  hot and scheduled backups, restore, rollback and rehearsal on a second machine, and the migration of an
  existing install from another format (done with a throwaway tool that is not part of this repository).
- The voice channel and the assistant prompt are in daily use on one install with the NanoVoice app.
- Details: [`real-install-test.md`](real-install-test.md) and [`spikes.md`](spikes.md).

## Known limits

- Restore is terminal-only and needs the service stopped; it cannot be started from the panel.
- Updating NanoClaw is not done from the panel.
- Not tested: a restore with a live channel account, and ChatGPT or Claude credentials from accounts other
  than the author's. The panel cannot check model names for ChatGPT or Claude.
- Ollama works through the OpenAI-compatible endpoint; on a CPU-only machine a small model was too slow and
  too weak to act as an agent. A larger model on a GPU has not been tried.
- Upstream (not these skills) logs an error and keeps a lease on every container restart, because of a race
  when it removes an auto-removed container. Details in [`spikes.md`](spikes.md).
- Backups sit on the same disk as the install by default: copy them elsewhere.

## Ideas, not started

- Hooking the scheduled backups' result into a notification.
