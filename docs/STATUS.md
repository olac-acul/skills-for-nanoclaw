# Project status

Single source of truth for where the work stands. Update it at the end of every
working session.

## Goal

Skills that add three things to a clean upstream NanoClaw install, with no
Docker Compose stack of our own and no channels preconfigured:

1. Model access through OpenAI-compatible APIs (upstream `/add-opencode`).
2. A local web panel for the main settings.
3. Backup, export and verified restore.

## Decisions

- Repository of skills only; no fork of upstream. Updates via upstream `/update-nanoclaw`.
- Credential gateway: upstream OneCLI, at the version pinned by upstream.
- UI language: English (strings kept in one file so other languages can be added).
- Panel reachable from localhost and the local network; HTTPS is optional and
  configured by the operator. Default bind is localhost.
- Backups from the panel wait for running agent turns to finish (configurable
  timeout) instead of killing them. Restores run from the terminal with the
  service stopped.
- Repository is private during development and made public after testing, so
  history must stay clean from the first commit (privacy gate is mandatory).

## Done

- [x] Repository skeleton, license, privacy gate with tests and pre-commit hook.
- [x] Spike 1: consistent snapshots of the central DB and of session mailboxes
      while another process writes (see `spikes.md`).

- [x] Spike 2: host-caller `dispatch` runs approval-gated `ncl` commands directly.
- [x] Spike 3: `node-tar` hangs with default concurrency on Node 26; own minimal tar chosen.
- [x] Spike 4: upstream has no non-killing admission pause; hot backups wait for idle and record `consistency`.
- [x] `add-manager-backup` skill: tar, authenticated encryption, bundle create/verify,
      transactional restore with rollback and rehearsal, retention, terminal CLI.
      71 tests; applies cleanly to upstream `main` with upstream's own engine
      (`node scripts/compose.mjs`); CLI exercised end to end on a scratch install.

- [x] `add-manager-panel` skill: server with Host/Origin/CSRF/Sec-Fetch checks, scrypt login
      with persistent throttle, sessions, re-authentication window, LAN-only guard,
      overview, agents (restart), model switch for all agents with rollback journal,
      backups (create/verify/download/delete, key shown once), setup CLI.
      110 tests including an end-to-end run on a migrated upstream database; both skills
      apply to upstream `main` on GitHub Actions with Node 22.

- [x] Real-install test on a clean Docker host (see `real-install-test.md`): skills apply, host runs
      with the panel, model switch, agent answers through an OpenAI-compatible endpoint, hot backup
      and terminal restore verified. Found and fixed two bugs.

## Next

- [ ] Restore onto a second machine (rehearsal mode on real data), a real channel, and a
      reproduction of the restart-after-adoption failure.
- [ ] Look at the panel UI in a real browser (the Chrome extension was not connected
      in the last session; `spikes/panel-dev.ts` in the test bed serves the real
      panel with fake data on 127.0.0.1:3299). Only static checks cover the UI script so far.
- [ ] Gateway state: decide per the "re-enter credentials" decision; document the
      reinstall checklist printed after a restore.
- [ ] Restore on a different machine from a real install (needs Docker host).
