/**
 * Redacts sensitive information from command strings
 */
export function redactSecrets(command: string): string {
  return command
    // Redact Authorization: Bearer <token>
    .replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, '$1***REDACTED***')
    // Redact Authorization: <token> (non-Bearer)
    .replace(/(Authorization:\s+(?!Bearer\s))(\S+)/gi, '$1***REDACTED***')
    // Redact tokens in environment variables (TOKEN, SECRET, PASSWORD, KEY, API_KEY, etc)
    .replace(/(\w*(?:TOKEN|SECRET|PASSWORD|KEY|AUTH)\w*)=(\S+)/gi, '$1=***REDACTED***')
    // Redact GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
    .replace(/\b(gh[pousr]_[A-Za-z0-9._-]{36,})/g, '***REDACTED***');
}

/**
 * Derives every textual form of a secret-derived endpoint that must be kept out
 * of logs, diagnostics and uploaded artifacts.
 *
 * `sensitiveAllowedDomains` entries are stored as `<scheme>://<host>`; the host
 * and `host:port` forms are derived here so that artifacts referencing the bare
 * hostname (e.g. `OPENAI_API_TARGET`) are redacted too.
 *
 * @param sensitiveAllowedDomains - Secret-derived allowlist entries.
 * @returns URL, host and host:port forms, longest first (so the most specific match wins).
 */
export function deriveSensitiveEndpointForms(sensitiveAllowedDomains?: string[]): string[] {
  const forms = new Set<string>();
  for (const entry of sensitiveAllowedDomains ?? []) {
    const value = entry.trim();
    if (!value) continue;
    const host = value.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//, '').replace(/\/.*$/, '');
    if (!host) continue;
    forms.add(value);
    forms.add(host);
    forms.add(`${host}:${/^http:\/\//i.test(value) ? '80' : '443'}`);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of the supplied sensitive values with `[REDACTED]`.
 *
 * @param text - Text to redact.
 * @param values - Sensitive values (see {@link deriveSensitiveEndpointForms}).
 * @returns The redacted text.
 */
export function redactSensitiveValues(text: string, values: string[]): string {
  let result = text;
  for (const value of values) {
    if (!value) continue;
    result = result.replace(
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      '[REDACTED]'
    );
  }
  return result;
}
