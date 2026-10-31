import { redactSensitiveValues } from '../redact-secrets';

export const PUBLIC_ENCLAVE_CAPTURE_BYTES = 1024 * 1024;

export function redactPublicEnclaveText(contents: Buffer, secrets: readonly string[]): Buffer {
  let text = contents.toString('utf8');
  const forms = secrets.filter(Boolean).flatMap(secret => [
    secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64'),
  ]);
  text = redactSensitiveValues(text, forms)
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n"\\]+/gi, '$1[REDACTED]')
    .replace(/\bbearer\s+[^\s"\\]+/gi, '[REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  const redacted = Buffer.from(text);
  if (redacted.length < PUBLIC_ENCLAVE_CAPTURE_BYTES && contents.length < PUBLIC_ENCLAVE_CAPTURE_BYTES) return redacted;
  const bounded = redacted.subarray(0, PUBLIC_ENCLAVE_CAPTURE_BYTES);
  const newline = bounded.lastIndexOf(10);
  return newline < 0 ? Buffer.alloc(0) : bounded.subarray(0, newline + 1);
}
