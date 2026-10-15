# Remove manager-backup

Reverses everything the skill added. Backups you created are your data and are
not touched; delete them yourself if you want them gone.

0. If you set up scheduled backups, remove their timer first (the key file and the backups stay):

   ```bash
   pnpm exec tsx scripts/manager-backup.ts schedule remove
   rm -f ~/.config/nanoclaw/scheduled-backup.key   # only if you no longer need to open those backups
   ```

1. Delete the copied files (there is nothing to un-register: the skill appended
   nothing to any barrel):

   ```bash
   rm -rf src/modules/manager-backup
   rm -f scripts/manager-backup.ts scripts/tsconfig.manager-backup.json
   ```

   The files are:

```text files
scripts/manager-backup.ts
scripts/tsconfig.manager-backup.json
src/modules/manager-backup/bundle.test.ts
src/modules/manager-backup/bundle.ts
src/modules/manager-backup/cli-args.test.ts
src/modules/manager-backup/cli-args.ts
src/modules/manager-backup/crypto.test.ts
src/modules/manager-backup/crypto.ts
src/modules/manager-backup/fixtures/synthetic-install.ts
src/modules/manager-backup/host.ts
src/modules/manager-backup/restore.test.ts
src/modules/manager-backup/restore.ts
src/modules/manager-backup/schedule.test.ts
src/modules/manager-backup/schedule.ts
src/modules/manager-backup/service.test.ts
src/modules/manager-backup/service.ts
src/modules/manager-backup/tar.test.ts
src/modules/manager-backup/tar.ts
src/modules/manager-backup/upstream-host.test.ts
src/modules/manager-backup/upstream-host.ts
src/modules/manager-backup/voice-files.test.ts
```

2. If another skill (for example `add-manager-panel`) imports from
   `src/modules/manager-backup/`, remove that skill first.

3. Build to confirm nothing referenced the module:

   ```bash
   pnpm run build
   ```
