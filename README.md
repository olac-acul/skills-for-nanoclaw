# skills-for-nanoclaw

> **Unofficial** add-on skills for [NanoClaw](https://github.com/nanocoai/nanoclaw).
> Not affiliated with, endorsed by, or maintained by the upstream project.

Skills that add to a clean upstream NanoClaw install without forking it: an installation is upstream plus the
skills it has installed, and it updates with upstream's own `/update-nanoclaw`. The manager skills edit no
upstream source file beyond one import line. `add-voice` also makes two small changes to core files, listed in
its own documentation, applied as exact anchored edits that stop and change nothing if upstream moves that code.

| Skill | What it adds |
| --- | --- |
| [`add-manager-panel`](.claude/skills/add-manager-panel/SKILL.md) | A web panel for the main settings: overview, agents, the model provider for all agents (an OpenAI-compatible endpoint such as Ollama, ChatGPT with a subscription login or an API key, or Claude), provider credentials stored in the credential gateway, backups, and a built-in guide. |
| [`add-manager-backup`](.claude/skills/add-manager-backup/SKILL.md) | Encrypted, verified backups and restores from the terminal (and from the panel): a restore with a way back if it fails, a rehearsal mode that never activates channel accounts, and weekly scheduled backups with a retention count. |
| [`add-voice`](.claude/skills/add-voice/SKILL.md) | A voice channel for the NanoVoice Android app: a token-protected WebSocket that streams the agent's replies to the phone and lets the agent run phone actions (timers, alarms, calendar changes with approval on the phone, music, notes, photos), with a setup script that enables it, wires it to an agent and shows what to enter in the app. |

Install `add-manager-backup` first; the panel builds on it. `add-voice` stands alone.

## Guide

The full guide is [`docs/guide.md`](docs/guide.md): installing, first run, reaching the panel over the network
and HTTPS, models and providers, backups and restores, everything that is terminal-only, troubleshooting and
reference. The panel serves the same text at `/guide`.

## Install

The skills follow upstream's skill format (`SKILL.md` with `nc:` blocks, `REMOVE.md`, files under `payload/`).
Copy the folders you want from `.claude/skills/` into the same folder of your NanoClaw checkout, then, in Claude
Code started in that checkout, run `/add-manager-backup` and then `/add-manager-panel`. Each skill checks that
the NanoClaw version has what it needs, copies its files, builds and runs its own tests, and tells you what is
left to do. Credentials are never asked for in chat: the panel and the terminal tools take them with hidden
input.

## What it was tested on

- Upstream NanoClaw 2.4.0 (revision `d249c0fb`), Node 22, Docker, the OneCLI gateway at upstream's pin and
  upstream's OpenCode provider, on Debian 13.
- Applied with upstream's own skill engine on a clean checkout, with upstream's build and the skills' tests
  (about 300 tests). A scheduled workflow does this against upstream `main` every night, so a change in
  upstream that breaks an integration point shows up there.
- Run for real on test installs: panel, model switch, provider credentials, hot backup, terminal restore on
  another machine, rollback, rehearsal restore, and a migration of an existing install.

Not tested, and said plainly: a restore with a live channel account, ChatGPT or Claude credentials of
accounts other than the author's, and an Ollama model larger than a small CPU-only one.

## Security notes

The panel is an administration surface: password login (scrypt) with a persistent throttle, server-side
sessions, CSRF and Origin checks, a re-authentication window for sensitive actions, a strict content security
policy, refusal of connections from public addresses, and no secret ever shown again after it is stored. It
serves plain HTTP unless you configure HTTPS and says so on every page. Read the *Security model* in the guide
before exposing it beyond a network you trust, and see [`SECURITY.md`](SECURITY.md) to report a problem.

## Status

Usable, with limits that are listed in [`docs/STATUS.md`](docs/STATUS.md). Technical findings about upstream
internals are in [`docs/spikes.md`](docs/spikes.md) and the results of runs on real installs in
[`docs/real-install-test.md`](docs/real-install-test.md).

## Development

```sh
node --test "scripts/*.test.mjs"                        # unit tests of the repo tooling
node scripts/privacy-scan.mjs --all --history           # privacy gate: files, and every commit's identity and message
node scripts/privacy-scan.mjs --history-content         # ...and every line ever added in any commit
git config core.hooksPath .githooks                     # enable the pre-commit gate
node scripts/testbed.mjs fix && node scripts/testbed.mjs check   # skills against an upstream checkout (see the script)
node scripts/compose.mjs                                # apply every skill to a clean upstream clone, as CI does
```

The pre-commit hook regenerates what is derived from hand-written files (the guide page served by the panel from
`docs/guide.md`, and the file lists in each skill's `SKILL.md` and `REMOVE.md`), so a commit never carries a stale
copy. Edit `docs/guide.md`, commit, and the generated file is part of the same commit.

The privacy gate blocks private network addresses, personal emails, credentials and non-anonymous git
identities. Use synthetic data in tests (`100.64.x.x` addresses, `.test` names, `example.*` emails). Before
publishing a repository like this one, also run it with `--deny-list <file>`: one pattern per line for the real
names, domains and account ids that must never appear, kept **outside** the repository.

## License

MIT
