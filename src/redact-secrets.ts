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
