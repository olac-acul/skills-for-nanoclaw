# Test on a real install (2026-10-02)

A clean Debian 13 LXC (4 CPU, 8 GiB, Docker 29 with Compose, nothing else) with
upstream NanoClaw `main` at `d249c0fb`, the credential gateway OneCLI at upstream's pin
(1.41.0), upstream's OpenCode provider, and both skills from this repo, driven end
to end with a mock OpenAI-compatible server.

## Procedure

1. Node 22 (official tarball, checksum verified), build tools, `corepack`, Bun 1.4.0 (upstream's
   container pin) and the `docker` group for the NanoClaw user.
2. `git clone` upstream, `pnpm install --frozen-lockfile`, `pnpm rebuild better-sqlite3`.
3. Apply `add-onecli`, `add-opencode`, `add-manager-backup`, `add-manager-panel` with upstream's
   own skill engine (`applySkill`, as `scripts/compose.mjs` does).
4. `scripts/upgrade-state.ts set` (the startup tripwire refuses a tree that did not come through
   setup), `pnpm run build`, start `node dist/index.js`.
5. `scripts/init-cli-agent.ts`, a mock server on the Docker bridge address answering
   `/v1/models` and streamed `/v1/chat/completions`.

## What was verified

| Check | Result |
| --- | --- |
| Skills apply on the real install (backup 5 steps, panel 6 steps, tests included) | pass |
| Host starts and the panel module listens (`127.0.0.1:3200`) | pass |
| First-run setup code, password creation, login, re-authentication | pass |
| Panel shows the real agent and channel | pass |
| Model change from the panel (`.env` + group config + restart) | pass |
| Agent container reaches an HTTP endpoint on the Docker bridge address through OneCLI and answers | pass |
| Chat through the CLI channel with the mock model, reply delivered | pass |
| Hot backup from the panel with an idle but running agent: `quiescent`, verifies with its key | pass |
| Stop host, restore from the terminal: newer messages, `.env` change and a new file all gone | pass |
| Host starts after the restore without tripping the upgrade check; agent answers; panel password still works | pass |
| `commit` removes the rollback copy and the scratch directories | pass |

## Bugs this found (all fixed)

- **Model limits.** OpenCode rejects a model definition with `limit.context` but no
  `limit.output`. The panel now writes `OPENCODE_MODEL_OUTPUT_LIMIT` together with the context
  limit (half the window, at most 4096) and removes both when the endpoint reports no window.
- **"Busy" is not "alive".** Agent containers stay up, idle, after they answer. Counting live
  containers made every hot backup fail with `agents_busy`. A session is now busy only when its
  mailbox has a message claimed and not finished (`processing_ack.status = 'processing'`).
- **Failed logins were not audited** (found by the server tests before this run).

## Still open

- **Restart reports success when the container stop failed.** After a model change right after a
  host restart, upstream's Docker driver logged `session realization failed` while stopping an
  adopted container (it was left in `Dead` state, removable by hand afterwards). Upstream's
  `restartAgentGroupContainers` swallows the error, so the panel cannot report it. Needs a
  reproduction and probably an upstream issue.
- Mock model replies had to use the agent's `<message to="...">` format; real models follow the
  system prompt. Not a skill problem.
- OneCLI's installer did not report its URL on the first run from the skill engine and worked on
  the second (the images had not been pulled yet). Rerun if it happens.
- A stack with a real channel is not tested.

## Second machine (2026-10-07)

A second clean Debian 13 LXC (same specs), set up exactly like the first: Docker, Node 22, Bun 1.4.0,
upstream `d249c0fb`, then `add-onecli`, `add-opencode` and both skills from this repo, applied with
upstream's engine. The install path is the same, so the install slug (and with it the container,
image and backup folder names) is the same. A hot backup (`quiescent`) of the first machine was copied
over together with its key.

| Check | Result |
| --- | --- |
| Rehearsal restore on the new machine: warns about what is missing, keeps this machine's `ONECLI_URL` / `NO_PROXY`, drops what could act as the original | pass |
| Central database rows match the first machine (agent groups, sessions, users, messaging groups, agents, container configs, schema version 23); host leases and session claims are cleared by design | pass |
| Session mailboxes match (14 inbound, 13 outbound messages); only the test chats sent afterwards are new | pass |
| The restored session resumes and the agent answers through the gateway and the model server | pass |
| `rollback` puts the previous state back and removes the transaction folder | pass |
| Full restore: the first machine's panel password works on the new one (rehearsal leaves the panel without an administrator, on purpose) | pass |
| `commit` discards the rollback copy and the scratch directories | pass |

Things to know (none needed a code change):

- **Gateway selection.** If the first run of `add-onecli` fails ("OneCLI installer did not report its
  URL") and is rerun, `NANOCLAW_GATEWAY_PROVIDER` may not end up in `.env`. A restore then warns
  *not installed on this host: gateway onecli* and, because this machine's own settings win, does not
  bring the backup's value over. Add `NANOCLAW_GATEWAY_PROVIDER=onecli` to `.env` before starting.
- **Empty database.** Before the first start, the restore's pre-flight checks leave an empty
  `data/v2.db` behind; a rollback restores that state.
- **Message wording.** In a rehearsal the `.env` summary prints `NO_PROXY` both as kept (this
  machine's value) and as dropped (the backup's); the file keeps this machine's value.
- Credentials in the gateway are not part of a backup (decided): they have to be entered again.
