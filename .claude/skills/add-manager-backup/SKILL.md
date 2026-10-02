---
name: add-manager-backup
description: Encrypted backup, verification and transactional restore of a NanoClaw install, from the terminal. Atomic restore with rollback, a rehearsal mode that never activates channel identities, and a per-backup key that is shown once.
---

# Manager backup

Back up everything an install needs to come back: the central database, every
agent session mailbox, agent group folders, channel stores, `.env` and the
machine-level allowlists. Restore it onto the same machine or a new one, with a
way back if the restored install does not come up.

This skill adds a library under `src/modules/manager-backup/` and one script,
`scripts/manager-backup.ts`. It does not touch any existing file and registers
nothing with the host, so nothing changes at runtime until you run the script.
(The `add-manager-panel` skill uses the same library for backups from the web
panel.)

## What is in a backup

- `db/v2.db`: a consistent snapshot of the central database (taken with SQLite's own copy, so it is safe while the host runs).
- `data/`: the data directory. Each session mailbox (`inbound.db`, `outbound.db`) is snapshotted the same way. Sockets, locks, heartbeats, per-spawn context and transient Dockerfiles are left out.
- `groups/` and `store/`: agent group folders and channel stores, with symlinks, hardlinks and numeric owners preserved.
- `.env` and, from `~/.config/nanoclaw`, the mount and sender allowlists. The device key, account and host id are included only with `--machine-identity`.
- A manifest (first in the file) with the release, the applied migrations, which channels, providers, modules and gateway were installed, and counts.

It is one file: tar, gzip, then AES-256-GCM in 1 MiB authenticated chunks. A
wrong key, a flipped bit, a truncated file or reordered chunks are all rejected;
nothing readable is stored at rest.

**Not in a backup:** container images (derived images are rebuilt after a
restore) and credentials held by the gateway (OneCLI). After restoring on a new
machine, install the gateway with its own skill and enter the credentials again.
The manifest lists which skills and gateway the backup came from, so you know
what to reinstall before starting.

## Install

Check that this NanoClaw version has the internals the library imports. If the
check fails, update NanoClaw first (`/update-nanoclaw`); do not copy the
files onto an older core.

```nc:run effect:check
node -e "const fs=require('fs');const need=[['src/db/driver.ts','DbDriver'],['src/db/migrations/index.ts','getRegisteredMigrations'],['src/upgrade-state.ts','getCodeIdentity'],['src/install-slug.ts','getInstallSlug'],['src/env.ts','readEnvFile'],['src/db/connection.ts','initDb'],['src/config.ts','DATA_DIR']];const ok=need.every(([f,s])=>fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes(s));process.exit(ok?0:1)"
```

Copy the library, its tests and the script. The copy is safe to repeat.

```nc:copy
payload/scripts/manager-backup.ts -> scripts/manager-backup.ts
payload/scripts/tsconfig.manager-backup.json -> scripts/tsconfig.manager-backup.json
payload/src/modules/manager-backup/bundle.test.ts -> src/modules/manager-backup/bundle.test.ts
payload/src/modules/manager-backup/bundle.ts -> src/modules/manager-backup/bundle.ts
payload/src/modules/manager-backup/crypto.test.ts -> src/modules/manager-backup/crypto.test.ts
payload/src/modules/manager-backup/crypto.ts -> src/modules/manager-backup/crypto.ts
payload/src/modules/manager-backup/fixtures/synthetic-install.ts -> src/modules/manager-backup/fixtures/synthetic-install.ts
payload/src/modules/manager-backup/host.ts -> src/modules/manager-backup/host.ts
payload/src/modules/manager-backup/restore.test.ts -> src/modules/manager-backup/restore.test.ts
payload/src/modules/manager-backup/restore.ts -> src/modules/manager-backup/restore.ts
payload/src/modules/manager-backup/service.test.ts -> src/modules/manager-backup/service.test.ts
payload/src/modules/manager-backup/service.ts -> src/modules/manager-backup/service.ts
payload/src/modules/manager-backup/tar.test.ts -> src/modules/manager-backup/tar.test.ts
payload/src/modules/manager-backup/tar.ts -> src/modules/manager-backup/tar.ts
payload/src/modules/manager-backup/upstream-host.test.ts -> src/modules/manager-backup/upstream-host.test.ts
payload/src/modules/manager-backup/upstream-host.ts -> src/modules/manager-backup/upstream-host.ts
```

Build, typecheck the script, and run the module's tests. The tests include one
that migrates a real database and restores a backup into it, so they fail if a
NanoClaw release changes something this library depends on.

```nc:run effect:build
pnpm run build
```

```nc:run effect:build
pnpm exec tsc -p scripts/tsconfig.manager-backup.json
```

```nc:run effect:test
pnpm exec vitest run src/modules/manager-backup
```

## Use

Backups go to `$MANAGER_BACKUP_DIR` (default `~/.local/share/nanoclaw-backups/<install>`).
Keep copies somewhere other than the disk that holds the install.

```bash
pnpm exec tsx scripts/manager-backup.ts create          # prints the key once
pnpm exec tsx scripts/manager-backup.ts list
pnpm exec tsx scripts/manager-backup.ts verify <id>     # reads and authenticates the whole file
pnpm exec tsx scripts/manager-backup.ts prune --keep-last 7 --keep-monthly 6
```

**The key.** Each backup has its own random 256-bit key, printed once at
creation and never stored. Put it in a password manager. Without it the backup
cannot be opened. Provide it later through `MANAGER_BACKUP_KEY`, `--key-file`,
or the hidden prompt; it is never accepted as a command-line argument.

**While the host runs** the backup is still safe (each database file is copied
consistently) but the files are not copied at the same instant, so it is
recorded as `best-effort`. Stop the service first for a `cold` backup.

## Restore

Stop the service, then:

```bash
pnpm exec tsx scripts/manager-backup.ts restore <id|file>
```

It authenticates the whole bundle before touching anything, shows what it will
do, and asks you to type `RESTORE`. It then stages the backup next to the
current data, swaps each directory by moving its contents (a symlinked or
mounted `data/` keeps its identity), and keeps the displaced state for rollback.

- **Older backup:** restored, and the host applies the newer migrations on first start. **Backup from newer code:** refused; update NanoClaw first.
- The restored database is made ready for a clean start: sessions marked stopped, host leases and session claims cleared, derived image tags cleared (the command lists the groups to rebuild).
- This install's own upgrade marker is kept, so the startup check does not trip.
- `--rehearsal` restores a copy that cannot act as the original: it keeps only a short allowlist of `.env` settings (no tokens or secrets), restores no channel stores or identity files, and pauses pending tasks and chats. Use it to test a backup on a second machine while the original is running.

After starting the service and checking it works:

```bash
pnpm exec tsx scripts/manager-backup.ts commit <transaction>     # discard the rollback copy
pnpm exec tsx scripts/manager-backup.ts rollback <transaction>   # or put everything back
```

Restoring replaces everything newer than the backup (messages, memory, tasks).
Only a rollback gets that back.
