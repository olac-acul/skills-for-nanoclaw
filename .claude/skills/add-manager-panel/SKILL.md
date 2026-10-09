---
name: add-manager-panel
description: Local web panel for a NanoClaw install. Overview, agents with restart, one OpenAI-compatible model endpoint for every agent with a rollback journal, and encrypted backups with the key shown once. Password login, localhost by default, LAN and HTTPS by configuration.
---

# Manager panel

A small web panel that runs inside the NanoClaw host process. It is meant for
the person who runs the install, from their own browser, on the same machine or
the local network.

- **Overview:** release, gateway, channels, providers, agents, running agents.
- **Agents:** list and restart.
- **Model:** point every agent at one provider: an OpenAI-compatible endpoint (a local server such as llama.cpp, vLLM or Ollama, or a hosted service), ChatGPT (subscription login or API key) or Claude (API key or subscription token). Keys and tokens are handed straight to the credential gateway and never shown again. The endpoint is checked first (`/models`, the model is listed, a one-token completion). The change writes the `OPENCODE_*` settings in `.env` and each group's provider and model, restarts the groups, and keeps a journal so a failure, or a crash in the middle, puts everything back.
- **Backups:** create (waits for running agents to finish), verify with the key, download, delete. Each backup has its own key, shown once. Restoring is done from the terminal (see `add-manager-backup`).

The panel serves a detailed guide at `/guide` (the source is `docs/guide.md` in this repository); every place where the panel hands you over to a terminal links to the matching section.

It adds no dependency and changes no existing code except one import line in
`src/modules/index.ts`. A panel that cannot start (port in use, bad
certificate, bad setting) logs why; NanoClaw keeps running.

## Prerequisites

- `add-manager-backup` installed first: the panel's backup page uses its library.
- `add-opencode` (upstream) for the agents to actually use an OpenAI-compatible endpoint or ChatGPT, and `add-onecli` (upstream) as the place credentials are kept. The panel only writes the settings those read; ChatGPT and Claude credential entry also needs both installed.

## Install

```nc:run effect:check
node -e "const fs=require('fs');const need=[['src/modules/manager-backup/service.ts','class BackupService'],['src/modules/index.ts','import'],['src/host-lifecycle.ts','onHostStart'],['src/container-restart.ts','restartAgentGroupContainers'],['src/db/container-configs.ts','updateContainerConfigScalars'],['src/db/agent-groups.ts','getAllAgentGroups'],['src/container-runner.ts','isContainerRunning']];process.exit(need.every(([f,s])=>fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes(s))?0:1)"
```

If that check fails, install `add-manager-backup` first, or update NanoClaw
(`/update-nanoclaw`) when the failing name is an upstream one.

```nc:copy
payload/scripts/manager-credentials.ts -> scripts/manager-credentials.ts
payload/scripts/manager-panel.ts -> scripts/manager-panel.ts
payload/scripts/tsconfig.manager-credentials.json -> scripts/tsconfig.manager-credentials.json
payload/scripts/tsconfig.manager-panel.json -> scripts/tsconfig.manager-panel.json
payload/src/modules/manager-panel/auth.ts -> src/modules/manager-panel/auth.ts
payload/src/modules/manager-panel/backend.ts -> src/modules/manager-panel/backend.ts
payload/src/modules/manager-panel/backup-job.test.ts -> src/modules/manager-panel/backup-job.test.ts
payload/src/modules/manager-panel/backup-job.ts -> src/modules/manager-panel/backup-job.ts
payload/src/modules/manager-panel/config.ts -> src/modules/manager-panel/config.ts
payload/src/modules/manager-panel/credentials-protocol.test.ts -> src/modules/manager-panel/credentials-protocol.test.ts
payload/src/modules/manager-panel/credentials-protocol.ts -> src/modules/manager-panel/credentials-protocol.ts
payload/src/modules/manager-panel/credentials.test.ts -> src/modules/manager-panel/credentials.test.ts
payload/src/modules/manager-panel/credentials.ts -> src/modules/manager-panel/credentials.ts
payload/src/modules/manager-panel/env-file.test.ts -> src/modules/manager-panel/env-file.test.ts
payload/src/modules/manager-panel/env-file.ts -> src/modules/manager-panel/env-file.ts
payload/src/modules/manager-panel/fixtures/fake-backend.ts -> src/modules/manager-panel/fixtures/fake-backend.ts
payload/src/modules/manager-panel/guide-html.ts -> src/modules/manager-panel/guide-html.ts
payload/src/modules/manager-panel/index.ts -> src/modules/manager-panel/index.ts
payload/src/modules/manager-panel/model-endpoint.test.ts -> src/modules/manager-panel/model-endpoint.test.ts
payload/src/modules/manager-panel/model-endpoint.ts -> src/modules/manager-panel/model-endpoint.ts
payload/src/modules/manager-panel/model-settings.test.ts -> src/modules/manager-panel/model-settings.test.ts
payload/src/modules/manager-panel/model-settings.ts -> src/modules/manager-panel/model-settings.ts
payload/src/modules/manager-panel/opaque-id.ts -> src/modules/manager-panel/opaque-id.ts
payload/src/modules/manager-panel/password.ts -> src/modules/manager-panel/password.ts
payload/src/modules/manager-panel/primitives.test.ts -> src/modules/manager-panel/primitives.test.ts
payload/src/modules/manager-panel/routes.ts -> src/modules/manager-panel/routes.ts
payload/src/modules/manager-panel/server.test.ts -> src/modules/manager-panel/server.test.ts
payload/src/modules/manager-panel/server.ts -> src/modules/manager-panel/server.ts
payload/src/modules/manager-panel/sessions.ts -> src/modules/manager-panel/sessions.ts
payload/src/modules/manager-panel/state.ts -> src/modules/manager-panel/state.ts
payload/src/modules/manager-panel/ui.ts -> src/modules/manager-panel/ui.ts
payload/src/modules/manager-panel/upstream-backend.test.ts -> src/modules/manager-panel/upstream-backend.test.ts
payload/src/modules/manager-panel/upstream-backend.ts -> src/modules/manager-panel/upstream-backend.ts
payload/src/modules/manager-panel/validate.ts -> src/modules/manager-panel/validate.ts
payload/src/modules/manager-panel/wiring.test.ts -> src/modules/manager-panel/wiring.test.ts
```

Append the module to the host's module list. This is the only edit to an
existing file; it is one import line.

```nc:append to:src/modules/index.ts
import './manager-panel/index.js';
```

Build, typecheck the script and run the tests. They include one that runs the
real server against a migrated database and the real backup library, and one
that fails if the import line above is removed.

```nc:run effect:build
pnpm run build
```

```nc:run effect:build
pnpm exec tsc -p scripts/tsconfig.manager-panel.json
```

The provider credentials helper builds on upstream's OpenCode and OneCLI skills. It is typechecked only
when they are installed; without them the panel works and simply does not offer ChatGPT or Claude
credentials.

```nc:run effect:build
if [ -f scripts/opencode-auth.ts ] && [ -f scripts/opencode-vault.ts ]; then pnpm exec tsc -p scripts/tsconfig.manager-credentials.json; else echo "add-opencode is not installed: provider credentials will not be offered"; fi
```

```nc:run effect:test
pnpm exec vitest run src/modules/manager-panel
```

Restart the NanoClaw service so the host loads the module.

## First run

1. Restart the service. The log says where the panel listens and, until an administrator exists, how to create one. If the host refuses to start with an "upgrade tripwire" message, the tree changed outside the setup flow (installing a skill does that); once the build and tests above passed, record it with `pnpm exec tsx scripts/upgrade-state.ts set` and start again (see `docs/upgrade-recovery.md`).
2. Create the administrator with a one-time code:

   ```bash
   pnpm exec tsx scripts/manager-panel.ts setup-code
   ```

   Open the address it prints, enter the code and choose a password (12 characters or more). The code works once and expires after 30 minutes.
3. Forgot the password later: `pnpm exec tsx scripts/manager-panel.ts reset-password` (from a terminal on the machine). `revoke-sessions`, `unlock` (after too many wrong passwords) and `status` are there too.

## Reaching the panel

By default it listens on `127.0.0.1:3200`, so it is reachable only from the
machine itself (or through an SSH tunnel). To use it from other devices on your
network, set in `.env` and restart:

```
PANEL_BIND=0.0.0.0
```

Connections from public internet addresses are refused even then (set
`PANEL_ALLOW_PUBLIC=true` to change that, which is not recommended). Requests
must also carry a local host name: an IP address, `localhost`, a bare name, or a
name ending in `.local`, `.lan`, `.internal` or `.home.arpa`. Add others with
`PANEL_ALLOWED_HOSTS=name1,name2`.

**Without HTTPS** the panel works, with a warning on every page: your password
and backup keys cross the network in clear text. That is acceptable on a
trusted home network and wrong anywhere else. Pick one:

- **Your own certificate:** `PANEL_TLS_CERT=/path/cert.pem` and `PANEL_TLS_KEY=/path/key.pem`.
- **A reverse proxy that terminates TLS:** keep `PANEL_BIND=127.0.0.1` (or the proxy's network), forward to port 3200, and set `PANEL_PUBLIC_ORIGIN=https://panel.example.org` so the origin and cookie checks match what the browser uses. Forward the original `Host` header.

Other settings: `PANEL_ENABLED=false` turns the panel off; `PANEL_PORT` (3200);
`PANEL_BACKUP_DIR` (default `~/.local/share/nanoclaw-backups/<install>`);
`PANEL_BACKUP_WAIT_SECONDS` (120): how long a backup waits for running agents.

## Security model

- One administrator, password hashed with scrypt; five wrong passwords are free, then a growing lock (up to an hour) that survives restarts.
- Sessions live in memory and expire after 30 minutes idle or 8 hours total; a password change signs everything out. The cookie is `HttpOnly` and `SameSite=Strict` (`__Host-` and `Secure` when served over HTTPS).
- Every change needs the CSRF token and an `Origin` equal to the panel's own. Model changes, creating, downloading and deleting backups also need the password typed again within the last five minutes.
- The panel never returns a credential, a path, a log line or an internal id (agents get keyed hashes). API keys are not entered or shown here: store a key for an endpoint that needs one with `pnpm exec tsx setup/index.ts --step provider-auth opencode`.
- State changes are audited (time, action, status, request id; never bodies) in `data/manager-panel/audit.jsonl`.
- The panel runs in the NanoClaw process, with its privileges. Treat access to it like a shell on the machine.

## Notes

- Applying a model change restarts every agent. Running turns are interrupted.
- The panel's own state (password hash, audit log) lives in `data/manager-panel/` and is included in backups.
- Updating NanoClaw is still done from the terminal with `/update-nanoclaw`.
