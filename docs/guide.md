# Manager guide

How to install, run and look after a NanoClaw install with the **manager** skills: the web panel
(`add-manager-panel`) and encrypted backups (`add-manager-backup`).

This guide is also served by the panel itself at `/guide`, and the panel links to the sections
below wherever something can only be done from a terminal.

> **Unofficial.** These skills are not part of NanoClaw and are not affiliated with its authors.
> They attach to upstream NanoClaw through its own extension points and change one line of its
> source (`src/modules/index.ts`).

## What you get

| | |
| --- | --- |
| **Web panel** | Overview, agents (restart), one OpenAI-compatible model endpoint for every agent, backups. Password login, English interface. |
| **Backups** | Encrypted single-file backups of the whole install, verification, restore with rollback, a rehearsal mode for testing a backup on another machine. |
| **Terminal tools** | `scripts/manager-backup.ts` and `scripts/manager-panel.ts`, for everything the panel deliberately does not do. |

What the panel does **not** do, on purpose: restore a backup, change passwords without a terminal,
store API keys, install channels, update NanoClaw. Those are in [Terminal-only tasks](#terminal-only-tasks).

## How it fits together

```
 browser ──HTTP(S)──▶ panel (inside the NanoClaw host process)
                         │  reads/writes .env and each group's config
                         │  restarts agent containers
                         └─ backup library ──▶ encrypted files in the backups folder

 terminal ─▶ scripts/manager-backup.ts   create / verify / restore / commit / rollback / prune
          └▶ scripts/manager-panel.ts    setup-code / reset-password / unlock / status
```

- The panel is a **module of the NanoClaw host**: it starts and stops with it. It has the same
  privileges as the NanoClaw user, so protect access to it like a shell on the machine.
- Models are not run by NanoClaw. Agents call an **OpenAI-compatible HTTP endpoint** you provide
  (a local server such as llama.cpp or vLLM, or a hosted provider) through upstream's OpenCode
  provider (`add-opencode`).
- Credentials for model providers live in the **credential gateway** (OneCLI by default), never in
  `.env` and never in a backup.

## Installing

### Requirements

- A working NanoClaw install, version 2.4 or later, with Docker. See upstream's README.
- The credential gateway skill (`add-onecli`) and the OpenCode provider (`add-opencode`) installed
  with upstream's own skills. The panel only writes the settings those read.
- Node 22 or later and pnpm, as NanoClaw itself needs.

What was actually tested: Debian 13 in an LXC container, Docker 29, Node 22.23, pnpm 10, Bun 1.4.0,
NanoClaw `main` at the time of writing, OneCLI 1.41.0, applying the skills with upstream's own skill
engine. Anything else is expected to work but was not tried.

### Applying the skills

Get this repository, then copy the two skill folders into the install:

```bash
cp -r skills-for-nanoclaw/.claude/skills/add-manager-backup  ~/nanoclaw/.claude/skills/
cp -r skills-for-nanoclaw/.claude/skills/add-manager-panel   ~/nanoclaw/.claude/skills/
```

Apply them in this order. In Claude Code, from the install folder:

```
/add-manager-backup
/add-manager-panel
```

Each skill checks its prerequisites, copies its files, builds, typechecks and runs its tests. The
panel skill also appends one line, `import './manager-panel/index.js';`, to `src/modules/index.ts`.
Both are safe to repeat.

To apply them without an agent (this is how they are tested), the repository has a script that does
it with upstream's own engine on a clean checkout:

```bash
node scripts/compose.mjs --upstream https://github.com/nanocoai/nanoclaw.git
```

### After installing: the upgrade check

NanoClaw refuses to start when its files changed outside its own setup or update flow. Installing a
skill counts as such a change, and you will see an *"upgrade tripwire"* message. Once the build and
tests of the skills passed, record the new state and start again:

```bash
pnpm exec tsx scripts/upgrade-state.ts set
```

Then rebuild if you changed code (`pnpm run build`) and restart the NanoClaw service.

## First run

After restarting, the host log says where the panel listens, for example:

```
Manager panel listening  bind=127.0.0.1 port=3200 https=false
Manager panel has no administrator yet. Run: pnpm exec tsx scripts/manager-panel.ts setup-code
```

### Create the administrator

```bash
pnpm exec tsx scripts/manager-panel.ts setup-code
```

It prints the panel address and a one-time code such as `ABCD-EFGH-JKMN-PQRS`. Open the address,
enter the code and choose a password of at least 12 characters. The code works once and expires after
30 minutes; run the command again for a new one. There is one administrator account.

## Reaching the panel

By default the panel listens on `127.0.0.1:3200`: only the machine itself can open it. Options:

- **From the same machine:** open `http://127.0.0.1:3200`.
- **From another computer, through SSH** (nothing to configure):
  `ssh -L 3200:127.0.0.1:3200 user@the-machine`, then open `http://127.0.0.1:3200` locally.
- **From other devices on the local network:** see [HTTPS and network access](#https-and-network-access).

### HTTPS and network access

Settings go in the install's `.env` file; restart NanoClaw after changing them.

To allow other devices on your network:

```
PANEL_BIND=0.0.0.0
```

Even then, connections from public internet addresses are refused, and the request's `Host` name
must be local: an IP address, `localhost`, a single-word name, or a name ending in `.local`, `.lan`,
`.internal` or `.home.arpa`. For any other name, list it:

```
PANEL_ALLOWED_HOSTS=panel.example.org,nas.mydomain.net
```

**Without HTTPS** the panel works but shows a warning on every page (except on localhost): your
password and backup keys cross the network unencrypted. That can be acceptable on a trusted home
network. Choose one of these to encrypt the connection:

1. **Your own certificate**, served by the panel:

   ```
   PANEL_TLS_CERT=/path/to/cert.pem
   PANEL_TLS_KEY=/path/to/key.pem
   ```

   The files are read when NanoClaw starts. The panel does not create or renew certificates.

2. **A reverse proxy that terminates TLS.** Keep the panel on localhost, point the proxy at it, and
   tell the panel the exact address the browser uses:

   ```
   PANEL_BIND=127.0.0.1
   PANEL_PUBLIC_ORIGIN=https://panel.example.org
   PANEL_ALLOWED_HOSTS=panel.example.org
   ```

   An example for nginx (not tested here; adapt it):

   ```
   server {
     listen 443 ssl;
     server_name panel.example.org;
     # ssl_certificate / ssl_certificate_key ...
     client_max_body_size 0;
     location / {
       proxy_pass http://127.0.0.1:3200;
       proxy_set_header Host $host;
       proxy_buffering off;
       proxy_read_timeout 300s;
     }
   }
   ```

   The long read timeout matters: creating a backup can wait for running agents (up to
   `PANEL_BACKUP_WAIT_SECONDS`, 120 by default), and downloads can be large.

With HTTPS the session cookie becomes `__Host-manager_panel` with the `Secure` flag, and the
`Strict-Transport-Security` header is sent.

If a page loads but every action fails with *origin_mismatch*, the address in the browser differs
from the one the panel expects: set `PANEL_PUBLIC_ORIGIN` exactly to what the address bar shows
(scheme, name and port, no trailing slash).

## Using the dashboard

Sign in with the administrator password. Sessions end after 30 minutes without activity or 8 hours in
total. Wrong passwords: five are free, then every further failure doubles a lock (one minute, two,
four, up to an hour). Sensitive actions (applying a model, creating, downloading or deleting a
backup) ask for the password again if you have not typed it in the last five minutes.

### Overview

Release, how many agents exist and how many are working, sessions, uptime, the credential gateway,
installed channels and providers, and the number and date of backups.

### Agents

One row per agent: provider, model and whether it is working. **Restart** stops the agent's
containers; the next message starts a fresh one with the current settings. Adding, wiring and
removing agents is not done here: see [Channels and agents](#channels-and-agents).

### Model

The page shows the endpoint and model all agents use. See [Models](#models) for how to use it.

### Backups

The list of backups with date, size, release and consistency, and the actions Verify, Download and
Delete. See [Backups](#backups). Restoring is not offered here: see
[Restoring a backup](#restoring-a-backup).

## Models

The **Model** page sets one provider for every agent. Three kinds are offered:

| Provider | What it is | Credential |
| --- | --- | --- |
| **OpenAI-compatible endpoint** | Any server that speaks the OpenAI API: a local model server, [Ollama](#ollama), or a hosted service. Agents use OpenCode. | None for most local servers; a key for hosted ones ([API keys](#api-keys)) |
| **[ChatGPT](#chatgpt)** | OpenAI models through your ChatGPT subscription or an OpenAI API key. Agents use OpenCode. | Subscription login or API key |
| **[Claude](#claude)** | Anthropic models through the Claude provider NanoClaw ships with. | API key or Claude subscription token |

Choosing a provider and pressing **Apply** changes every agent at once, with the same rollback as
described in [How a model change works](#how-a-model-change-works). The page shows which provider is in use.

### Connecting an endpoint

An endpoint is the base URL of an OpenAI-compatible API, ending in `/v1`, for example
`http://model-server:8000/v1` or `https://api.example-provider.com/v1`.

1. Open **Model**. Enter the endpoint and the model name exactly as the server lists it.
2. Press **Check endpoint**. The panel asks the server for its model list, confirms your model is in
   it, and sends a one-token test request. The list becomes the suggestions of the model field.
3. If the check passed, **Apply to all agents** becomes available. It asks for your password.

Rules the panel enforces on the address:

- Loopback, private-network (home or office LAN, VPN) and unique-local addresses may use plain HTTP.
- A public address must use HTTPS.
- Link-local addresses (including cloud metadata services), multicast and reserved ranges are refused.
- No credentials, query string or fragment in the URL.

From inside the agent containers the machine running NanoClaw is reachable at the Docker bridge
address (shown by `docker network inspect bridge`, usually the first one in the 172.17 range) or at
`host.docker.internal` <!-- privacy-scan: allow -->; `localhost` inside a container is the
container itself. A model server on the same machine as NanoClaw therefore needs an address such as
`http://<bridge-address>:8000/v1` and must listen on that interface, not only on `127.0.0.1`.

### The small model

OpenCode, the provider that talks to the endpoint, can use a second, lighter model for minor
background work. The field **Small model (optional)** sets it. Leave it empty to use the main model
for everything, which is the right choice when you run a single model. The panel does not check that
the small model exists on the endpoint; a wrong name shows up when OpenCode first tries to use it.

### API keys

Model providers' keys and tokens are kept in the **credential gateway** (OneCLI), never in `.env` and
never in a backup. There are two ways to put one there:

- **In the panel.** On the ChatGPT and Claude forms, paste the key and press **Save**. The password is
  asked again first. The value goes from your browser to the panel, to a helper process, to the
  gateway, and is never shown or returned again. Saving again replaces the stored value and keeps the
  agents' access to it.
- **From a terminal**, with upstream's tool, which also covers keys for a hosted OpenAI-compatible
  service:

  ```bash
  pnpm exec tsx setup/index.ts --step provider-auth opencode
  ```

  Choose the local or self-hosted option, enter the endpoint and, when asked, the key.

> **Over plain HTTP a key crosses your network in clear text** when you paste it into the panel. The
> panel warns about this on every page except localhost. Use localhost, an SSH tunnel or
> [HTTPS](#https-and-network-access) when you enter secrets.

Entering keys in the panel needs the OpenCode and OneCLI skills installed (`add-opencode`,
`add-onecli`) because the helper that stores them is built on those. Without them the panel says so and
simply does not offer ChatGPT or Claude credentials.

A *401* result from **Check endpoint** (*the endpoint wants an API key*) means the key is missing or the
endpoint is not the one the key was stored for.

### Ollama

[Ollama](https://ollama.com) runs models on your own machine and speaks the OpenAI API at
`http://<address>:11434/v1`. The panel uses it as an OpenAI-compatible endpoint; no key is needed.

1. Install Ollama and pull a model that supports tool calls, for example `ollama pull <model>`. Agents
   use tools heavily, and models without reliable tool use do poorly.
2. Make Ollama reachable **from the agent containers**. By default it listens on `127.0.0.1` only, which
   a container cannot reach. Set `OLLAMA_HOST=<bridge address>:11434` in Ollama's service environment and restart it (the
   Docker bridge address is what **Use Ollama** shows; `0.0.0.0` also works but opens the port to your
   network). Remember to set the same `OLLAMA_HOST` when you run `ollama pull`.
3. On the **Model** page choose *OpenAI-compatible endpoint* and press **Use Ollama**. It fills in the
   Docker bridge address of this machine with port 11434 and checks it; the models you pulled appear
   as suggestions in the **Model** field.
4. Pick a model, **Check endpoint**, then **Apply to all agents**.

**Ollama on another machine.** Type its address in the **Endpoint** field instead of pressing **Use
Ollama**: `http://<address>:11434/v1`, then **Check endpoint** and **Apply**. This is the usual setup
with a GPU server. On that machine, make Ollama listen on a reachable address (`OLLAMA_HOST=0.0.0.0:11434`,
or one interface's address) and allow port 11434 through its firewall. Ollama has no login, so expose it
only on a network you trust, or put a reverse proxy with HTTPS and authentication in front. The panel
accepts plain HTTP for private and local addresses and requires HTTPS for anything else. The agent
containers reach the address through the credential gateway like any other endpoint; in a test, the check
from one machine and a real agent request from its container both reached an Ollama on another machine
this way.

**Speed.** An agent's first request carries about 2,000 tokens of instructions. On a CPU-only machine a
3-billion-parameter model reads them at roughly 40 tokens a second, so even a small model needs a minute
or more before it starts to answer, and more again to write the reply. A GPU, or a hosted endpoint, is
the practical choice for day-to-day use. The first **Check endpoint** can also be slow, because the model
is loaded into memory by that first request; for a model on this machine the panel waits up to two
minutes for it.

**Model size.** In a test on a CPU-only machine, `qwen2.5:3b` took about ten minutes to answer a
greeting, and the answer was not in the format agents must use (a `<message to="...">` block), so
nothing was delivered: it talked about creating a directory it had no reason to touch. The pipeline
(panel, endpoint, agent, model) worked; the model was too small and too slow for an agent. Expect to
need a much larger model and a GPU for useful results.

**Context window.** Ollama's default window is 4,096 tokens (`OLLAMA_CONTEXT_LENGTH` in its service
environment raises it). Agents with long conversations or many tools need more; if answers stop
following the instructions, raise it. Ollama does not report the window to the panel, so the panel
leaves the context limits unset for it.

NanoClaw's own skill for Ollama (`add-ollama-provider`) takes a different route: it points the Claude
provider at Ollama's Anthropic-style API and edits each agent's container settings. The panel does not
use it. The two should not be combined.

### ChatGPT

Agents reach OpenAI through OpenCode, with the credential injected by the gateway. Two ways to
authenticate:

- **Subscription login.** Press **Sign in with ChatGPT** (the password is asked again). The panel starts
  OpenCode's device pairing in a short-lived container and shows a page and a code. Open the page, sign
  in to ChatGPT there and enter the code. The panel waits up to 15 minutes and stores the login in the
  gateway, which refreshes it by itself. **Cancel** stops the attempt.
- **API key.** Paste an OpenAI API key and press **Save**.

Then enter the **model name exactly as OpenAI names it**, optionally a small model, and press **Apply**.
The panel cannot check the name: the credential lives in the gateway and cannot be read back to ask
OpenAI. A wrong name shows up the first time an agent tries to use it.

What Apply writes: `OPENCODE_PROVIDER=openai`, `OPENCODE_BASE_URL=native`, `OPENCODE_MODEL` and
`OPENCODE_SMALL_MODEL` as `openai/<name>`, and for a subscription login `OPENCODE_AUTH_MODE=chatgpt`
(removed for an API key). Any context limits from an earlier endpoint are removed.

The sign-in needs Docker (it runs OpenCode in a container) and the agent image built with the OpenCode
provider.

### Claude

This is the provider NanoClaw ships with (the Claude Agent SDK), not OpenCode. Its credential is an
**Anthropic API key** or a **Claude subscription token**. For a subscription, run
`claude setup-token` in a terminal, sign in as it asks, and paste the token it prints into the panel.
**Save** stores it in the gateway as the secret named *Anthropic* for `api.anthropic.com`, replacing a
previous one.

Applying Claude sets every agent's provider back to the default (Claude) and, if you enter one, its
model; leave the model empty to use the provider's default. The `OPENCODE_*` settings are left alone, so
switching back to an endpoint later is one step.

As with ChatGPT, the panel cannot check a model name against Anthropic. Use the full name Anthropic
gives (for example `claude-haiku-4-5-20251001`); a short or invented name such as `haiku-4.5` makes every
agent answer with *There's an issue with the selected model*.

### Removing a credential

Next to each stored credential there is a **Remove** button (click it twice, then confirm your
password). It deletes the secret from the gateway: the ChatGPT login, the OpenAI key (the secret named
*OpenCode openai*) or the Anthropic one. The panel refuses while the agents are using that credential,
so switch to another provider first. Removing something that is already gone is not an error. Removing
a ChatGPT login here does not sign you out of ChatGPT itself; revoke an API key on the provider's own
site as well if you no longer want it to work.

### How a model change works

Applying a change (an endpoint, ChatGPT or Claude) does this, in order:

1. Checks the endpoint again.
2. Writes a **journal** with the previous `.env` values and every agent's previous provider and model.
3. Writes the `OPENCODE_*` settings to `.env`: for an endpoint, `OPENCODE_PROVIDER`, `OPENCODE_BASE_URL`,
   `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL` and, when the server reports its context window,
   `OPENCODE_MODEL_CONTEXT_LIMIT` and `OPENCODE_MODEL_OUTPUT_LIMIT` (half the window, at most 4096);
   for ChatGPT the settings listed in [ChatGPT](#chatgpt); for Claude nothing.
4. Sets every agent group's provider and model: `opencode` and `openai/<model>`, or the default
   provider (Claude) with the model you gave.
5. Verifies what was written, then restarts every agent.
6. Deletes the journal.

If anything fails before the restarts, or NanoClaw stops in the middle, everything is put back from
the journal (automatically at the next start in the second case). A restart that fails after the
change was written does not undo it: the affected agents pick the settings up the next time they
start. Running turns are interrupted by the restarts.

Both limits are written together or not at all because OpenCode rejects a context limit without an
output limit.

### Endpoint checks and errors

| Message | What it means and what to do |
| --- | --- |
| *Could not reach the endpoint* | Wrong address or port, server down, firewall, or the server listens only on `127.0.0.1`. |
| *The endpoint does not list that model* | The model name differs from what `/v1/models` returns. Pick one from the suggestions. |
| *The endpoint wants an API key* | See [API keys](#api-keys). |
| *Plain HTTP is only accepted for local addresses* | Use HTTPS for a public host, or a local address. |
| *That address is not allowed* | Link-local, multicast or reserved address. |
| *The name could not be resolved* | DNS does not know the host name from the NanoClaw machine. |
| *The TLS certificate could not be verified* | Self-signed or expired certificate on an HTTPS endpoint. |
| *The endpoint did not answer like an OpenAI-compatible API* | The URL is not the API root (often missing `/v1`). |
| *The model did not answer a test request* | The server lists the model but fails on a completion; check its log. |
| *The change failed and the previous settings were restored* | Something broke while applying; nothing changed. Check the NanoClaw log. |

## Backups

### What a backup contains

One encrypted file holding:

- the central database (a consistent snapshot);
- every agent's session data, including each conversation's databases (snapshotted safely);
- agent group folders (memory, files, plugins) and channel stores;
- the `.env` file and the allowlists in `~/.config/nanoclaw`;
- a manifest: release, applied migrations, which skills and gateway were installed, counts.

Left out: sockets and lock files, per-run scratch data, logs, container images (rebuilt after a
restore), and the machine's own identity files unless you ask for them (`--machine-identity`).

**Not included: the credentials in the credential gateway.** After restoring onto a new machine,
install the gateway skill and enter the credentials again. The manifest lists which skills and
gateway the backup came from.

### The backup key

Each backup gets its own random 256-bit key, shown **once**, when the backup is created, as 64
hexadecimal characters in groups of eight. It is not stored anywhere, not even in the panel. Put it in
a password manager. Without the key the backup cannot be opened, by anyone.

The key is needed to verify, restore and inspect a backup, never to list or delete one. In the panel,
**Verify** asks for the key; the terminal commands read it from the `MANAGER_BACKUP_KEY` environment
variable, from `--key-file <path>`, or from a hidden prompt, never from a command-line argument.

### Consistency levels

| Level | Meaning |
| --- | --- |
| `cold` | NanoClaw was stopped. Everything is from the same instant. |
| `quiescent` | NanoClaw was running but no agent was working on a message. |
| `best-effort` | An agent was working. Each database file is still consistent, but files were not copied at the same instant. |

From the panel, **Create backup** first waits (up to 120 seconds by default) for agents that are in the
middle of a turn. Agents that are alive but idle do not count. If agents are still busy afterwards the
backup is refused, unless you tick *Back up even if agents are running*, which records `best-effort`.

### Retention and pruning

Backups accumulate in the backups folder (`~/.local/share/nanoclaw-backups/<install>` by default, or
`PANEL_BACKUP_DIR` / `MANAGER_BACKUP_DIR`). The panel can delete single backups; to keep the newest few
and one per month:

```bash
pnpm exec tsx scripts/manager-backup.ts prune --keep-last 7 --keep-monthly 6
```

Keep copies on **another disk or machine**: a backup next to the data it protects does not protect
against losing the disk. A downloaded or copied `.mbk` file is all you need besides its key.

Backups from the panel need the panel's reauthentication and a person to save the key. Unattended
scheduled backups are not provided: they would require storing the key next to the backups.

### Restoring a backup

Restoring is **terminal-only** and needs NanoClaw **stopped**: it replaces the data the running host is
using. Stop the service first (and the agent containers, which keep running on their own), then:

```bash
pnpm exec tsx scripts/manager-backup.ts list
pnpm exec tsx scripts/manager-backup.ts restore <id>
```

The command asks for the key, authenticates the whole file before touching anything, prints what it
will do, and asks you to type `RESTORE`. Then it:

1. unpacks into a staging area next to the live data;
2. swaps `data/`, `groups/` and `store/` by moving their contents (a symlinked or mounted folder keeps
   its identity), keeping the old state for rollback;
3. writes `.env`, keeping this machine's own `ONECLI_*`, `NANOCLAW_GATEWAY_PROVIDER`, `PANEL_*` and
   `no_proxy` settings;
4. prepares the database for a clean start: sessions marked stopped, host leases and session claims
   cleared, derived image tags cleared.

Facts to know:

- A backup **older** than the installed code is restored, and NanoClaw applies the newer migrations at
  its next start. A backup **newer** than the installed code is refused: update NanoClaw first.
- This install's own upgrade marker is kept, so the startup check does not trip.
- **The gateway selection.** If this machine has no credential gateway selected in `.env` (an install
  that did not finish its setup) and the backup's gateway skill is installed here, the restore sets
  `NANOCLAW_GATEWAY_PROVIDER` to the backup's value and says so. A machine that already selects a
  gateway keeps its own choice; if it differs from the backup's, the restore warns.
- **Credentials to enter again.** Gateway credentials are not in a backup, but their **names** are
  (never the values). The restore lists the ones this machine does not have yet, for example
  `OpenCode openai, Anthropic`; enter them again in the panel (Model page) or with the gateway's own
  tools. A backup made while the gateway could not be asked has no list.
- Everything newer than the backup (messages, memory, tasks) is replaced. The rollback copy is the only
  way back.
- Agent groups whose container image was customised are listed; rebuild them with
  `ncl groups restart --id <group> --rebuild`.

Start NanoClaw and check that it works. Then either keep the result or undo it:

```bash
pnpm exec tsx scripts/manager-backup.ts commit <transaction>     # delete the rollback copy
pnpm exec tsx scripts/manager-backup.ts rollback <transaction>   # put everything back
```

The transaction id is printed by `restore`. If the restore fails part way, it rolls itself back. After
`commit` or `rollback` only the last transaction's small journal stays in `.manager-backup-txn/`, so that
repeating the command can say what already happened.

### Rehearsal restore

`restore <id> --rehearsal` restores a copy that **cannot act as the original**. Use it to test a backup on
a second machine while the first is still running, without two installs answering the same chats. It:

- keeps only a short allowlist of `.env` settings and drops anything that looks like a token or secret
  (it prints the names it dropped);
- does not restore channel stores, channel login files or the machine's identity;
- marks pending tasks as paused and closes pending chat messages.

Conversation history, memory and the agents' files are kept. To go live afterwards, do a normal
restore (or reinstall the channels' credentials yourself).

### Moving to another machine

1. On the old machine: create a backup (cold, with NanoClaw stopped, if you can) and save the key.
2. On the new machine: install NanoClaw, the gateway, the provider and both manager skills, plus the
   channel skills the backup used (the restore warns about missing ones). Re-enter the gateway
   credentials.
3. Copy the `.mbk` file into the new backups folder (or pass its path to `restore`).
4. Run a [rehearsal restore](#rehearsal-restore) first, check the agents, then restore for real with
   the old machine stopped, so that two installs never talk to the same accounts.

## Terminal-only tasks

These are deliberately not in the panel. Each is a short recipe; all commands run in the NanoClaw install
folder as the NanoClaw user.

| Task | Where |
| --- | --- |
| Create the administrator, or get a new setup code | [Create the administrator](#create-the-administrator) |
| Forgot the password, locked out, sign everyone out | [Forgotten password](#forgotten-password) |
| Store or change a model provider's API key (also possible in the panel) | [API keys](#api-keys) |
| Restore a backup, roll back a restore | [Restoring a backup](#restoring-a-backup) |
| Test a backup on another machine | [Rehearsal restore](#rehearsal-restore) |
| Prune old backups | [Retention and pruning](#retention-and-pruning) |
| Open the panel to the network or enable HTTPS | [HTTPS and network access](#https-and-network-access) |
| Add channels and agents | [Channels and agents](#channels-and-agents) |
| Update NanoClaw | [Updating NanoClaw](#updating-nanoclaw) |
| Rebuild an agent's image | [Rebuilding agent images](#rebuilding-agent-images) |
| Uninstall | [Removing the skills](#removing-the-skills) |

### Forgotten password

From a terminal on the machine:

```bash
pnpm exec tsx scripts/manager-panel.ts reset-password   # asks twice, hidden; signs everyone out
pnpm exec tsx scripts/manager-panel.ts unlock           # clear the lock after too many wrong passwords
pnpm exec tsx scripts/manager-panel.ts revoke-sessions  # sign every browser out
pnpm exec tsx scripts/manager-panel.ts status           # address, administrator set up?, failed logins
```

Whoever can run these has the same access as the NanoClaw user, so this is the recovery path and also
the reason to keep the machine itself protected.

### Channels and agents

The panel shows the channels that are installed and the agents that exist; it does not create them.
Use upstream's tools: the setup wizard, `/manage-channels`, `/add-telegram`, `/add-signal` and the other
`/add-*` skills in Claude Code, `scripts/init-first-agent.ts`, and the `ncl` command-line tool
(`bin/ncl groups ...`). Follow upstream's documentation for those. After installing a channel skill,
restart NanoClaw; the new channel shows on the panel's Overview.

### Updating NanoClaw

Use upstream's flow from Claude Code, in the install folder:

```
/update-nanoclaw
```

It works in a staging copy, takes a snapshot, runs the migrations, checks health and rolls back by
itself on failure. Before updating, create a backup from the panel or the terminal.

Upstream refreshes only the channel and provider skills it knows. The manager skills are local code:
after an update, fetch the latest version of this repository, copy the two skill folders over the
installed ones and run `/add-manager-backup` and `/add-manager-panel` again, then rebuild and restart.
The nightly job of this repository applies the skills to upstream's newest code and reports when an
upstream change breaks one, so check the repository before updating if you are unsure.

### Rebuilding agent images

Agent groups can have a customised container image (extra packages). Images are not part of a backup.
After a restore, or when you change a group's packages:

```bash
bin/ncl groups restart --id <group-id> --rebuild
```

### Removing the skills

Each skill has a `REMOVE.md` that lists exactly what to undo: delete the copied files, delete the one
import line from `src/modules/index.ts`, rebuild. Remove the panel before the backup skill (the panel
uses the backup library). Your backups and the `data/manager-panel/` folder (password hash, audit log)
are yours to delete.

## Security model

- One administrator. The password is hashed with scrypt (memory-hard) and never stored or logged.
- Wrong passwords: five free, then a growing lock that survives restarts.
- Sessions are server-side, in memory (a restart signs everyone out), with an unguessable 256-bit
  token in an `HttpOnly`, `SameSite=Strict` cookie.
- Every request must carry a local `Host`; cross-site requests are refused; every state change needs
  the CSRF token **and** an `Origin` equal to the panel's own.
- Sensitive actions need the password again within the last five minutes.
- Connections from public internet addresses are refused unless `PANEL_ALLOW_PUBLIC=true`.
- Responses are built field by field: no credentials, no filesystem paths, no log lines, no internal
  ids (agents are shown under keyed hashes). Error responses carry a code and a request id only.
- State changes are audited (time, action, status, request id; never bodies) in
  `data/manager-panel/audit.jsonl`.
- Backups are encrypted with AES-256-GCM in authenticated chunks; a wrong key, a changed bit, a
  truncated or reordered file is rejected. The key never touches the disk of the machine.
- The panel runs with the NanoClaw user's privileges.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| NanoClaw prints *upgrade tripwire* and stops | The tree changed outside setup. See [After installing: the upgrade check](#after-installing-the-upgrade-check). |
| No panel, log says *did not start* | The log line names the cause: port in use (`PANEL_PORT`), unreadable certificate files, invalid setting. NanoClaw itself keeps running. |
| Panel opens but says *host_not_allowed* (421) | The address uses a name that is not local. Add it to `PANEL_ALLOWED_HOSTS`. |
| *network_not_allowed* (403) | The request came from a public internet address. Intended; see [Security model](#security-model). |
| *origin_mismatch* | Behind a proxy or with a different name than expected: set `PANEL_PUBLIC_ORIGIN`. |
| Cannot sign in, *login_throttled* | Too many wrong passwords. Wait, or run `scripts/manager-panel.ts unlock`. |
| *Create backup* says agents are still running | An agent is working. Retry later, or tick *Back up even if agents are running*. |
| Agents fail with *Missing key limit.output* | An old panel version wrote a context limit without an output limit; apply the model once more from the current panel. |
| Agent answers nothing, container log says no `<message>` blocks | The model does not follow NanoClaw's reply format. Use a model that follows instructions. |
| After a model change an agent still uses the old one | Its restart failed (look in the host log for *Failed to stop session*). Run *Restart* again, or `docker rm -f` the stuck container. |
| *Provider credentials need the OpenCode and OneCLI skills installed* | The helper that stores keys is built on `add-opencode` and `add-onecli`. Install them, then apply the panel skill again. |
| *The credential gateway is not reachable* | OneCLI is not running. Check it (`docker ps`) and the `ONECLI_URL` in `.env`. |
| The ChatGPT sign-in shows no page and code | Docker is not available to the NanoClaw user, or the agent image is missing. Build it (`./container/build.sh build`) and retry. |
| Apply says *credential_missing* | The credential for that provider is not stored yet. Save the key or sign in first. |
| Restore refuses: *host_running* | NanoClaw is still running. Stop it first. |
| Restore refuses: *backup_newer* | The backup was made by newer code. Update NanoClaw, then restore. |
| Restore warns: *not installed on this host* | The backup used channels or a gateway this install lacks. Install those skills before starting. |
| Verify says *wrong key, or the backup is damaged* | Wrong key or a damaged file. The two cannot be told apart by design. |
| Model check: *Could not reach the endpoint* from a server on the same machine | Use the Docker bridge address, and make the server listen on it. See [Connecting an endpoint](#connecting-an-endpoint). |

When asking for help, include the NanoClaw log lines around the problem and the request id shown in
the error (never the key, the password or the contents of `.env`).

## Reference

### Settings

All optional, in the install's `.env` (or the environment).

| Setting | Default | Meaning |
| --- | --- | --- |
| `PANEL_ENABLED` | `true` | `false` turns the panel off. |
| `PANEL_BIND` | `127.0.0.1` | Address to listen on. `0.0.0.0` for all interfaces. |
| `PANEL_PORT` | `3200` | Port. |
| `PANEL_PUBLIC_ORIGIN` | unset | The exact origin browsers use when behind a proxy, such as `https://panel.example.org`. |
| `PANEL_ALLOWED_HOSTS` | unset | Comma-separated extra host names accepted. |
| `PANEL_TLS_CERT`, `PANEL_TLS_KEY` | unset | PEM files to serve HTTPS directly. Set both or neither. |
| `PANEL_ALLOW_PUBLIC` | `false` | `true` accepts connections from public internet addresses. Not recommended. |
| `PANEL_BACKUP_DIR` | `~/.local/share/nanoclaw-backups/<install>` | Where the panel keeps backups. |
| `PANEL_BACKUP_WAIT_SECONDS` | `120` | How long a backup waits for busy agents. |
| `MANAGER_BACKUP_DIR` | same as above | Backups folder for the terminal tool. |
| `MANAGER_BACKUP_KEY` | unset | The key for the terminal tool (prefer `--key-file` or the prompt). |

### Terminal commands

```text
scripts/manager-backup.ts create [--machine-identity]
scripts/manager-backup.ts list
scripts/manager-backup.ts verify <id|file>
scripts/manager-backup.ts restore <id|file> [--rehearsal] [--machine-identity] [--yes]
scripts/manager-backup.ts commit <transaction>
scripts/manager-backup.ts rollback <transaction>
scripts/manager-backup.ts prune [--keep-last N] [--keep-monthly N]
        (all accept --dir <folder> and --key-file <path>)

scripts/manager-panel.ts setup-code | reset-password | revoke-sessions | unlock | status
```

Run them as `pnpm exec tsx scripts/<name>.ts ...`.

### Files and folders

| Path | What |
| --- | --- |
| `data/manager-panel/` | Panel state, private (mode 0700): password hash, login lock, audit log, identifier key, model-change journal. Included in backups. |
| `~/.local/share/nanoclaw-backups/<install>/` | Backups (`<id>.mbk`) and their small description files (`<id>.meta.json`). |
| `.manager-backup-txn/` inside `data/`, `groups/`, `store/` | Rollback copies during a restore; removed by `commit` or `rollback`. |
| `src/modules/manager-backup/`, `src/modules/manager-panel/` | The skills' code. |

### HTTP API

For the curious or for scripting. Everything is under `/api/v1`, JSON, `Cache-Control: no-store`.
State-changing calls need the cookie, the `X-CSRF-Token` header and an `Origin` equal to the panel's.

| Method and path | Needs password again | What |
| --- | --- | --- |
| `GET /health` | no | `{"status":"ok"}`, no session needed |
| `GET /setup`, `POST /setup` | no | first-run status; create the administrator |
| `POST /session`, `GET /session`, `DELETE /session` | no | sign in, read session, sign out |
| `POST /session/reauth` | no | type the password again |
| `GET /overview`, `GET /agents`, `GET /channels` | no | read |
| `POST /agents/{id}/restart` | no | restart an agent |
| `GET /model` | no | current model settings |
| `POST /model/preflight` | no | check a provider choice (`kind`: `compatible`, `chatgpt` or `claude`) |
| `POST /model/apply` | yes | apply it to all agents |
| `GET /credentials` | no | which provider credentials are stored (booleans) |
| `POST /credentials/claude`, `POST /credentials/openai-key` | yes | store a key or token; nothing is returned |
| `DELETE /credentials/claude`, `/openai-key`, `/chatgpt-login` | yes | remove a stored credential; refused with 409 while in use |
| `POST`, `GET`, `DELETE /credentials/chatgpt/login` | start: yes | ChatGPT device sign-in: start, poll for page and code, cancel |
| `GET /backups` | no | list |
| `POST /backups` | yes | create; the response holds the key, once |
| `POST /backups/{id}/verify` | no | verify with a key |
| `GET /backups/{id}/download` | yes | the encrypted file |
| `DELETE /backups/{id}` | yes | delete |

## Known limits

- One provider for all agents; a different provider per agent is not offered.
- The panel cannot check a ChatGPT or Claude model name, because the keys live in the gateway.
- The ChatGPT sign-in and the Claude credential were tested against the real gateway and, for the sign-in, against OpenAI's real pairing page, but not completed with a real account.
- Restoring and updating are terminal-only.
- Credentials in the gateway are not part of backups.
- The panel starts and stops with NanoClaw; it cannot start NanoClaw.
- A restart requested from the panel is reported as done even if a stuck container could not be
  removed; check the log if an agent keeps its old behaviour.
- Tested on a single Debian 13 host with one agent and a mock model server. Channels, several machines
  and long-running installs have not been exercised.
- The guide's nginx example, `/update-nanoclaw` followed by re-applying the skills, and applying the
  skills with the `/add-manager-*` commands in Claude Code have not been tried end to end.
