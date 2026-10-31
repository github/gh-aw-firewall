import { redactSensitiveValues } from '../redact-secrets';

export const PUBLIC_ENCLAVE_CAPTURE_BYTES = 1024 * 1024;

export function redactPublicEnclaveText(contents: Buffer, secrets: readonly string[]): Buffer {
  let text = contents.toString('utf8');
  const forms = secrets.filter(Boolean).flatMap(secret => [
    secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
  ]);
  const redact = (value: string) => redactSensitiveValues(value, forms)
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bbearer\s+[^\r\n]+/gi, '[REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  const project = (value: unknown, depth = 0): unknown => {
    if (depth > 64) return '[REDACTED]';
    if (typeof value === 'string') {
      const decode = (text: string): string | undefined => {
        try {
          const decoded: unknown = JSON.parse(text);
          if (typeof decoded === 'string' || (decoded && typeof decoded === 'object')) {
            return JSON.stringify(project(decoded, depth + 1));
          }
        } catch { /* Ordinary diagnostic text is not necessarily JSON. */ }
        return undefined;
      };
      return decode(value) ?? value.split('\n').map(line => decode(line) ?? redact(line)).join('\n');
    }
    if (Array.isArray(value)) return value.map(item => project(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        redact(key), /^(?:proxy-)?authorization$/i.test(key) ? '[REDACTED]' : project(item, depth + 1),
      ]));
    }
    return value;
  };
  text = project(text) as string;
  const redacted = Buffer.from(text);
  if (redacted.length < PUBLIC_ENCLAVE_CAPTURE_BYTES && contents.length < PUBLIC_ENCLAVE_CAPTURE_BYTES) return redacted;
  const bounded = redacted.subarray(0, PUBLIC_ENCLAVE_CAPTURE_BYTES);
  const newline = bounded.lastIndexOf(10);
  return newline < 0 ? Buffer.alloc(0) : bounded.subarray(0, newline + 1);
}
