/** Panel settings, read from `.env` / the environment. Everything has a safe default. */
import os from 'node:os';
import path from 'node:path';

export interface PanelConfig {
  enabled: boolean;
  bind: string;
  port: number;
  publicOrigin?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  allowedHosts: string[];
  /** Accept connections from public internet addresses. */
  allowPublic: boolean;
  backupDir: string;
  backupWaitSeconds: number;
}

export const PANEL_ENV_KEYS = [
  'PANEL_ENABLED',
  'PANEL_BIND',
  'PANEL_PORT',
  'PANEL_PUBLIC_ORIGIN',
  'PANEL_TLS_CERT',
  'PANEL_TLS_KEY',
  'PANEL_ALLOWED_HOSTS',
  'PANEL_ALLOW_PUBLIC',
  'PANEL_BACKUP_DIR',
  'PANEL_BACKUP_WAIT_SECONDS',
] as const;

export class PanelConfigError extends Error {}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new PanelConfigError(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

export function parsePanelConfig(env: Record<string, string | undefined>, installSlug: string): PanelConfig {
  const origin = env.PANEL_PUBLIC_ORIGIN?.trim() || undefined;
  if (origin) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new PanelConfigError('PANEL_PUBLIC_ORIGIN must be an origin such as https://panel.example.org');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) {
      throw new PanelConfigError(
        'PANEL_PUBLIC_ORIGIN must be exactly an origin (scheme, host, optional port; no path)',
      );
    }
  }
  const cert = env.PANEL_TLS_CERT?.trim() || undefined;
  const key = env.PANEL_TLS_KEY?.trim() || undefined;
  if (Boolean(cert) !== Boolean(key))
    throw new PanelConfigError('PANEL_TLS_CERT and PANEL_TLS_KEY must be set together');
  return {
    enabled: (env.PANEL_ENABLED ?? 'true').toLowerCase() !== 'false',
    bind: env.PANEL_BIND?.trim() || '127.0.0.1',
    port: integer(env.PANEL_PORT, 3200, 1, 65535, 'PANEL_PORT'),
    publicOrigin: origin,
    tlsCertFile: cert,
    tlsKeyFile: key,
    allowedHosts: (env.PANEL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    allowPublic: (env.PANEL_ALLOW_PUBLIC ?? '').toLowerCase() === 'true',
    backupDir:
      env.PANEL_BACKUP_DIR?.trim() || path.join(os.homedir(), '.local', 'share', 'nanoclaw-backups', installSlug),
    backupWaitSeconds: integer(env.PANEL_BACKUP_WAIT_SECONDS, 120, 0, 3600, 'PANEL_BACKUP_WAIT_SECONDS'),
  };
}

/** True for addresses that only this machine can reach. */
export function isLoopbackBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}
