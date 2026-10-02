/**
 * Manager panel module: starts the web panel with the host and stops it with
 * the host. Registered by one import line in `src/modules/index.ts`.
 *
 * A panel that cannot start (port in use, bad certificate, bad setting) logs
 * why and leaves NanoClaw running; it never takes the host down.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { readEnvFile } from '../../env.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { getInstallSlug } from '../../install-slug.js';
import { log } from '../../log.js';
import { BackupService } from '../manager-backup/service.js';
import { countBusySessions, createUpstreamHost } from '../manager-backup/upstream-host.js';
import { PANEL_ENV_KEYS, isLoopbackBind, parsePanelConfig } from './config.js';
import { recoverModelChange } from './model-settings.js';
import { createPanelServer } from './server.js';
import { PanelState } from './state.js';
import { createUpstreamBackend } from './upstream-backend.js';

let server: http.Server | null = null;

export async function startManagerPanel(): Promise<void> {
  try {
    const projectRoot = process.cwd();
    const fromFile = readEnvFile([...PANEL_ENV_KEYS], projectRoot);
    const env = Object.fromEntries(PANEL_ENV_KEYS.map((key) => [key, process.env[key] ?? fromFile[key]]));
    const config = parsePanelConfig(env, getInstallSlug(projectRoot));
    if (!config.enabled) {
      log.info('Manager panel disabled (PANEL_ENABLED=false)');
      return;
    }

    const state = new PanelState(path.join(DATA_DIR, 'manager-panel'));
    const host = createUpstreamHost({ db: getDb(), busyAgentCount: () => countBusySessions(DATA_DIR), projectRoot });
    const backups = new BackupService({ host, backupsDir: config.backupDir });
    const backend = createUpstreamBackend({ projectRoot, state, backups });

    const recovered = await recoverModelChange(backend.model);
    if (recovered !== 'none') log.warn('Recovered an interrupted model change', { outcome: recovered });

    const tls =
      config.tlsCertFile && config.tlsKeyFile
        ? { cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }
        : undefined;
    const panel = createPanelServer({
      state,
      backend,
      tls,
      publicOrigin: config.publicOrigin,
      allowedHosts: config.allowedHosts,
      backupWaitMs: config.backupWaitSeconds * 1000,
      lanOnly: !config.allowPublic,
      onError: (err) => log.error('Manager panel request failed', { err }),
    });
    await new Promise<void>((resolve, reject) => {
      panel.once('error', reject);
      panel.listen(config.port, config.bind, () => {
        panel.off('error', reject);
        resolve();
      });
    });
    server = panel;

    const encrypted = Boolean(tls) || config.publicOrigin?.startsWith('https:') === true;
    log.info('Manager panel listening', { bind: config.bind, port: config.port, https: encrypted });
    if (!isLoopbackBind(config.bind) && !encrypted) {
      log.warn(
        'Manager panel is reachable over plain HTTP; passwords and backup keys cross the network unencrypted. Configure HTTPS (PANEL_TLS_CERT/PANEL_TLS_KEY, or a proxy with PANEL_PUBLIC_ORIGIN).',
      );
    }
    if (state.admin() === null) {
      log.warn('Manager panel has no administrator yet. Run: pnpm exec tsx scripts/manager-panel.ts setup-code');
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- a panel that cannot start must never take the host down; the cause is logged
  } catch (err) {
    log.error('Manager panel did not start; NanoClaw continues without it', { err });
  }
}

export async function stopManagerPanel(): Promise<void> {
  const current = server;
  server = null;
  if (!current) return;
  current.closeAllConnections();
  await new Promise<void>((resolve) => current.close(() => resolve()));
}

onHostStart(startManagerPanel);
onHostShutdown(stopManagerPanel);
