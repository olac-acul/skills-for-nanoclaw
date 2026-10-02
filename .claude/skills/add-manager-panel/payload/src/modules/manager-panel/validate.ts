/** Tiny request-body validators: exact shapes, bounded values, nothing else accepted. */
export class InvalidBody extends Error {
  constructor(readonly field: string) {
    super(`invalid ${field}`);
  }
}

export type FieldSpec = { type: 'string'; max: number; optional?: boolean } | { type: 'boolean'; optional?: boolean };

/** Accept a plain object with exactly the declared fields. Empty strings count as absent. */
export function fields<T extends Record<string, string | boolean | undefined>>(
  raw: unknown,
  spec: Record<string, FieldSpec>,
): T {
  if (raw === undefined && Object.values(spec).every((rule) => rule.optional)) raw = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new InvalidBody('body');
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!(key in spec)) throw new InvalidBody(key);
  const out: Record<string, string | boolean | undefined> = {};
  for (const [key, rule] of Object.entries(spec)) {
    const value = body[key];
    if (value === undefined || value === '') {
      if (!rule.optional) throw new InvalidBody(key);
      continue;
    }
    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') throw new InvalidBody(key);
    } else if (typeof value !== 'string' || value.length > rule.max || value.includes('\0')) {
      throw new InvalidBody(key);
    }
    out[key] = value;
  }
  return out as T;
}

/** Accept no body at all, or an empty object. */
export function noBody(raw: unknown): undefined {
  fields(raw, {});
  return undefined;
}
