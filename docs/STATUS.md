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

## Next

- [ ] Spike 2: can a host module change group config without interactive approval?
- [ ] Spike 3: tar library behaviour (hardlinks, symlinks, numeric owners).
- [ ] Spike 4: inbound hold + admission close during a snapshot.
- [ ] Spikes needing Docker (OneCLI install, bind address, HTTP model endpoint).
- [ ] First skill: `add-manager-backup` (CLI first, then panel integration).
