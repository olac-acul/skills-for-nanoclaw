/**
 * Pure helpers for the terminal script: a strict argument parser, a whole-number check and a sanitizer for
 * text that came from a bundle, a sidecar or the environment.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** `true` takes a value (`--keep 3` or `--keep=3`); `false` is a switch. */
export type FlagTable = Record<string, boolean>;

const DIR: FlagTable = { dir: true };

/** Known flags per command. A command that is not listed accepts none. */
export const COMMAND_FLAGS: Record<string, FlagTable> = {
  create: { ...DIR, 'machine-identity': false },
  list: DIR,
  verify: { ...DIR, 'key-file': true },
  restore: { ...DIR, 'key-file': true, rehearsal: false, 'machine-identity': false, yes: false },
  commit: DIR,
  rollback: DIR,
  prune: { ...DIR, 'keep-last': true, 'keep-monthly': true },
  schedule: { ...DIR, keep: true, weekday: true, time: true },
  scheduled: { ...DIR, keep: true },
};

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Parse `argv` (without node and the script). Unknown flags and missing or unexpected values are refused. */
export function parseArgs(argv: string[], table: Record<string, FlagTable> = COMMAND_FLAGS): ParsedArgs {
  const first = argv.find((arg) => !arg.startsWith('--'));
  const known: FlagTable = (first !== undefined && Object.hasOwn(table, first) ? table[first] : undefined) ?? {};
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!Object.hasOwn(known, name)) throw new UsageError(`unknown option --${name}`);
    if (!known[name]) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      flags.set(name, true);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    if (value === '') throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { positional, flags };
}

/** A whole number of at least `min`, from a flag value (or `fallback` when the flag is absent). */
export function wholeNumber(name: string, value: string | true | undefined, min: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value) || Number(value) < min)
    throw new UsageError(`--${name} must be a whole number of ${min} or more`);
  return Number(value);
}

/** Drop control characters (C0 except tab, DEL, C1) so text from a bundle cannot drive the terminal. */
export function printable(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '');
}

/** True when a file with this mode can be read by its group or by others. */
export function looseKeyMode(mode: number): boolean {
  return (mode & 0o044) !== 0;
}
