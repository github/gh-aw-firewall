import { createHash } from 'crypto';
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? 'null' : canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Finite schema must be JSON-serializable');
  return encoded;
}

/** Returns the canonical SHA-256 used by the enclave broker for a finite schema. */
export function finiteSchemaHash(schema: unknown): string {
  return createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex');
}
