# Remove Signal with a number of its own

1. Delete the registration line `import './signal.js';` from `src/channels/index.ts` (delete it, do not comment it
   out), and the wirings of the Signal groups (`ncl wirings help`).
2. Delete the copied files:

```text files
scripts/signal-register.sh
setup/install-signal-cli.sh
src/channels/signal-registration.test.ts
src/channels/signal.test.ts
src/channels/signal.ts
```

3. Remove the `SIGNAL_*` lines from `.env` (`SIGNAL_ACCOUNT`, `SIGNAL_DM_ALLOW`, `SIGNAL_GROUP_ALLOW`,
   `SIGNAL_PROFILE_NAME`, and any `SIGNAL_TCP_*`, `SIGNAL_CLI_PATH`, `SIGNAL_MANAGE_DAEMON`, `SIGNAL_DATA_DIR`), then
   `pnpm run build` and restart NanoClaw.
4. To give the number up: `signal-cli -a <number> unregister`, then delete `~/.local/share/signal-cli` and, if nothing
   else uses it, `~/.local/bin/signal-cli`. Without unregistering, the number stays registered to the keys in that
   folder.
