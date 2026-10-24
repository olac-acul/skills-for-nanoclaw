/**
 * The seam between this module and the NanoClaw host.
 *
 * Everything the backup code needs from upstream internals goes through this
 * interface. `upstream-host.ts` is the only file that imports upstream
 * modules, so when upstream moves something there is exactly one place to fix
 * (and the nightly compatibility build points at it).
 */

export interface CodeIdentity {
  version: string;
  commit: string;
  tree: string;
}

export interface InstalledInventory {
  channels: string[];
  providers: string[];
  containerProviders: string[];
  modules: string[];
  gateway: string | null;
  driver: string | null;
}

export interface DbDescription {
  dialect: string;
  /** Applied migration names, sorted. */
  migrations: string[];
  /** Row counts of a few identity tables, used for sanity checks after a restore. */
  counts: Record<string, number>;
}

export interface BackupHost {
  projectRoot: string;
  dataDir: string;
  groupsDir: string;
  storeDir: string;
  /** Path of the `.env` file (may not exist). */
  envFile: string;
  /** `~/.config/nanoclaw`, or null when unavailable. */
  homeConfigDir: string | null;
  identity(): CodeIdentity;
  installSlug(): string;
  installed(): InstalledInventory;
  /** Credential gateways whose skill is installed here, whether or not one is selected in `.env`. */
  installedGateways(): string[];
  /**
   * Names (never values) of the credentials stored in the selected gateway, so a restore can say which
   * ones to enter again. `null` when the gateway cannot be asked.
   */
  gatewayCredentialNames?: () => Promise<string[] | null>;
  /** Names of every migration the running code knows about (core and modules). */
  registeredMigrations(): string[];
  describeDb(): Promise<DbDescription>;
  /**
   * Agents in the middle of a turn right now (not merely containers that are alive and idle);
   * undefined when not running inside the host process.
   */
  busyAgentCount?: () => number;
  /**
   * Agent containers of this install still running (alive at all, busy or not); null when that cannot be known
   * (no container runtime to ask).
   */
  runningAgentContainers?: () => number | null;
  /** Write a consistent point-in-time copy of the central database to `dest`. */
  snapshotCentralDb(dest: string): Promise<void>;
}
