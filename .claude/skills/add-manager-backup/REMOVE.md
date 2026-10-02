# Remove manager-backup

Reverses everything the skill added. Backups you created are your data and are
not touched; delete them yourself if you want them gone.

1. Delete the copied files (there is nothing to un-register: the skill appended
   nothing to any barrel):

   ```bash
   rm -rf src/modules/manager-backup
   rm -f scripts/manager-backup.ts scripts/tsconfig.manager-backup.json
   ```

   The files are:

```
scripts/manager-backup.ts
scripts/tsconfig.manager-backup.json
src/modules/manager-backup/bundle.test.ts
src/modules/manager-backup/bundle.ts
src/modules/manager-backup/crypto.test.ts
src/modules/manager-backup/crypto.ts
src/modules/manager-backup/fixtures/synthetic-install.ts
src/modules/manager-backup/host.ts
src/modules/manager-backup/restore.test.ts
src/modules/manager-backup/restore.ts
src/modules/manager-backup/service.test.ts
src/modules/manager-backup/service.ts
src/modules/manager-backup/tar.test.ts
src/modules/manager-backup/tar.ts
src/modules/manager-backup/upstream-host.test.ts
src/modules/manager-backup/upstream-host.ts
```

2. If another skill (for example `add-manager-panel`) imports from
   `src/modules/manager-backup/`, remove that skill first.

3. Build to confirm nothing referenced the module:

   ```bash
   pnpm run build
   ```
