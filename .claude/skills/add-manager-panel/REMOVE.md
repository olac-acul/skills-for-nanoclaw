# Remove manager-panel

Reverses everything the skill added. The panel's state in
`data/manager-panel/` (password hash, audit log) is yours to delete.

1. Delete the barrel registration line (delete it, do not comment it out) from
   `src/modules/index.ts`:

   ```
   import './manager-panel/index.js';
   ```

2. Delete the copied files:

   ```bash
   rm -rf src/modules/manager-panel
   rm -f scripts/manager-panel.ts scripts/tsconfig.manager-panel.json
   ```

   The files are:

```text files
scripts/manager-panel.ts
scripts/tsconfig.manager-panel.json
src/modules/manager-panel/auth.ts
src/modules/manager-panel/backend.ts
src/modules/manager-panel/config.ts
src/modules/manager-panel/env-file.test.ts
src/modules/manager-panel/env-file.ts
src/modules/manager-panel/fixtures/fake-backend.ts
src/modules/manager-panel/index.ts
src/modules/manager-panel/model-endpoint.test.ts
src/modules/manager-panel/model-endpoint.ts
src/modules/manager-panel/model-settings.test.ts
src/modules/manager-panel/model-settings.ts
src/modules/manager-panel/opaque-id.ts
src/modules/manager-panel/password.ts
src/modules/manager-panel/primitives.test.ts
src/modules/manager-panel/routes.ts
src/modules/manager-panel/server.test.ts
src/modules/manager-panel/server.ts
src/modules/manager-panel/sessions.ts
src/modules/manager-panel/state.ts
src/modules/manager-panel/ui.ts
src/modules/manager-panel/upstream-backend.test.ts
src/modules/manager-panel/upstream-backend.ts
src/modules/manager-panel/validate.ts
src/modules/manager-panel/wiring.test.ts
```

3. Remove the `PANEL_*` settings from `.env` if you set any, then rebuild and
   restart the service:

   ```bash
   pnpm run build
   ```
