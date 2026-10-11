# Technical spikes

Measured against upstream NanoClaw `main` (version 2.4.0, commit d249c0fb,
Node 26 with better-sqlite3 13.0.3). Scripts used are reproduced in the notes.

## Spike 1: snapshots while another process writes

### Central DB (`data/v2.db`, WAL)

`VACUUM INTO '<file>'` issued through upstream's `DbDriver.exec` while a second
process inserted ~420k rows/s:

- 5 of 5 snapshots passed `PRAGMA integrity_check`; row counts were consistent
  and all 23 migrations present.
- Snapshot time scaled with size: 130 ms at 90 MB, 925 ms at 690 MB.
- The copy is written in `journal_mode=delete`, not WAL. Fine for a backup
  artifact; the host switches it back to WAL when it opens the restored file.

Conclusion: a hot snapshot of the central DB is safe with `VACUUM INTO`. No
need to stop the host for this part. Gate it on `db.dialect === 'sqlite'`.

### Session mailboxes (`inbound.db` / `outbound.db`, `journal_mode=DELETE`)

A writer process committed small transactions continuously; 2,561 copy trials
per strategy:

| Strategy | Valid copies | Torn copies |
| --- | --- | --- |
| plain file copy | 2,538 | **23 (0.9%)** |
| `better-sqlite3` online backup | 2,561 | 0 |
| `VACUUM INTO` | 2,561 | 0 |

Conclusion: never copy session DB files with a plain file copy while a
container may be writing. Use the SQLite-aware copy. Attachment and outbox
files are ordinary files and still need the agents drained (planned behaviour).

## Spike 2: running approval-gated `ncl` commands from a host module

`groups config update` is declared `access: 'approval'`. In `dispatch()`
(`src/cli/dispatch.ts`) an approval hold is only ever created for **agent**
callers; for `{ caller: 'host' }` the guard allows the command directly.

Verified in-process against a fresh migrated DB:

```ts
await dispatch({ id, command: 'groups-config-update', args: { id: 'g1', provider: 'opencode', model: 'openai/x' } }, { caller: 'host' });
// -> ok: true, container_configs row updated
```

The same command with `{ caller: 'agent', ... }` goes down the approval path
instead. Conclusion: a host module (panel, CLI) can reuse the exact `ncl`
validation and persistence by calling `dispatch` as the host. No approval
prompt, no direct SQL against `container_configs`. `restartAgentGroupContainers`
is exported for the restart step.

## Spike 3: tar handling for the backup bundle

`node-tar` 7.5.22 on Node 26.10:

- **Hang.** With the default `jobs: 4`, packing a small tree (a 5 MB file, a
  hardlink pair, symlinks) never completes and never errors; `jobs: 1` or
  `jobs: 2` completes. Each entry alone, and several pairs, packed fine. I could
  not test Node 22 (not installed here), so whether this is specific to Node 26
  is unknown. Either way a silent hang in a backup path is unacceptable.
- Upstream NanoClaw does not depend on `tar`, so adding it would be a new
  dependency in every install.

Decision: write a small purpose-built archive writer/reader (ustar + PAX headers
only, no GNU extensions), used only for bundles this tool itself produces.
Benefits: no dependency, no concurrency surprises, and the reader can reject
anything the writer would never emit (unknown type flags, absolute or `..`
paths, duplicate members, links that leave the allowed subtree, hardlinks to
anything but an earlier regular file in the same archive). Numeric uid/gid are
stored in the headers and applied explicitly on restore.

To verify when it is written: symlink write-through attack (symlink `a` then a
file `a/x`), hardlink fidelity, dangling absolute symlinks (container skill
links), numeric owners, multi-GB streaming memory use.

## Spike 4: pausing agents during a hot backup

Upstream's only way to stop new containers from starting is
`stopGatewaySessionsForUnavailability()`, which closes admission **and kills
every running container** (`killContainer(..., 'gateway-unavailable')`), and the
gateway availability monitor can reopen admission on its own. There is no
"drain" or "pause" API, and scheduled tasks and sweep wakes bypass the inbound
message interceptor.

Decision: a hot backup does not close admission. It waits (up to a configurable
timeout) until `the busy-agent count is zero, then snapshots. Every
database file is copied with SQLite's own copy, so each file is consistent on
its own; what a running agent can still skew is the relative timing of
different files. The result is recorded in the manifest:

| `consistency` | Meaning |
| --- | --- |
| `cold` | the host was stopped |
| `quiescent` | no agent container was running when the snapshot started or ended |
| `best-effort` | agents were active; each file is consistent, files are not simultaneous |

If agents are still running when the wait ends, the backup is refused unless the
caller forces a best-effort one. The terminal CLI records `cold` when the host
socket is not accepting connections.

## Spike 5: applying a skill with upstream's engine

`scripts/compose.mjs` clones upstream, installs it, applies each skill with
upstream's `applySkill` (the same engine `/setup` uses), lints its directives
and runs the build and test steps it declares. `add-manager-backup` applies with
5 steps, no agent bounces, and 71 passing tests against upstream `main` at
`d249c0fb`. Lessons: a `capture:` only works on `effect:refresh`; a precondition
gate should be `effect:check` (exit code, no capture).

## Spike 6: "Session teardown incomplete" on every container restart (upstream)

Seen on the test install (upstream 2.4.0): every restart of an agent's container, whether from the
panel's *Apply* or from `ncl groups restart`, logs

```
ERROR Failed to stop session ... err={ message: "session realization failed: unknown" ... }
      at #confirmRemoved (drivers/docker-driver) <- DockerHandle.stop <- killContainer
ERROR Session teardown incomplete; retaining its claim and gateway lease
```

Cause, reproduced by hand: agent containers are created with `AutoRemove=true`. `DockerHandle.stop()`
runs `docker stop`, which already starts the automatic removal, then `docker rm --force`, which
fails with *removal of container ... is already in progress* (exit 1). `#confirmRemoved()` then
lists the container, still present for a moment, and throws instead of treating it as gone.
Docker's events confirm the sequence (`kill, stop, die, destroy`).

Effect: the container is gone and the next message starts a new one normally, so nothing visibly
breaks; the host keeps the session's claim and gateway lease and logs an error each time. The
panel's restart count is not affected (it reports the restart as done).

It is an upstream issue and independent of these skills. Possible fix there: treat "already in
progress" as success, or re-check with a short retry before throwing. Not reported upstream yet.
