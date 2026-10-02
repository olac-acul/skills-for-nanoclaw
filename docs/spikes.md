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
