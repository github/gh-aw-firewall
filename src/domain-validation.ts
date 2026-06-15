/**
 * Security validation for domain names and wildcard patterns
 *
 * This module is the Squid-injection prevention path for both --allow-domains
 * and --allow-urls. All checks here are security-critical: they prevent
 * malicious input from escaping into the generated Squid configuration.
 */

import { parseDomainWithProtocol } from './domain-patterns';

/**
 * Characters that are dangerous in Squid config files when interpolating domain names
 * or URL regex patterns. Squid config is line-and-space delimited, so:
 * - Whitespace (space, tab, CR, LF) can split ACL tokens or inject new directives
 * - Null bytes may terminate strings unexpectedly
 * - `#` starts a Squid config comment, truncating the rest of the line
 * - Quotes (", ', `) and `;` can interfere with config parsing
 *
 * Note: backslash is intentionally excluded here because URL regex patterns passed to
 * `--allow-urls` legitimately use `\` for regex escaping (e.g., `\\.` or `[^\\s]`).
 * Domain names are additionally validated to reject `\` in validateDomainOrPattern().
 */
export const SQUID_DANGEROUS_CHARS = /[\s\0"'`;#]/;

/**
 * Reject characters that could inject Squid config directives or tokens.
 * Also rejects backslash: domain names never legitimately contain backslashes,
 * and they could be used in regex injection if they reach Squid config.
 */
function checkDangerousChars(trimmed: string): void {
  const DOMAIN_DANGEROUS_CHARS = /[\s\0"'`;#\\]/;
  const match = trimmed.match(DOMAIN_DANGEROUS_CHARS);
  if (match) {
    const safeDomainForMessage = JSON.stringify(trimmed);
    const charCode = match[0].charCodeAt(0);
    const charDesc = charCode <= 0x20 || charCode === 0x7f
      ? `U+${charCode.toString(16).padStart(4, '0')}`
      : `'${match[0]}'`;
    throw new Error(
      `Invalid domain ${safeDomainForMessage}: contains invalid character ${charDesc}. ` +
      `Domain names must not contain whitespace, quotes, semicolons, backticks, hash characters, backslashes, or control characters.`
    );
  }
}

/**
 * Reject patterns that are too broad to be meaningful security allowlist entries:
 * `*`, `*.*`, and any pattern composed only of `*` and `.` characters.
 */
function checkOverBroadPattern(trimmed: string): void {
  if (trimmed === '*') {
    throw new Error("Pattern '*' matches all domains and is not allowed");
  }

  if (trimmed === '*.*') {
    throw new Error("Pattern '*.*' is too broad and is not allowed");
  }

  // Any pattern composed entirely of wildcards and dots (e.g. *.*, *.*.*) is too broad
  if (/^[*.]+$/.test(trimmed) && trimmed.includes('*')) {
    throw new Error(`Pattern '${trimmed}' is too broad and is not allowed`);
  }
}

/**
 * Reject structurally invalid domain strings: double dots, lone dot,
 * and patterns with too many wildcard segments.
 */
function checkStructuralValidity(trimmed: string): void {
  // Double dots are never valid in domain names
  if (trimmed.includes('..')) {
    throw new Error(`Invalid domain '${trimmed}': contains double dots`);
  }

  // A lone dot is not a valid domain
  if (trimmed === '.') {
    throw new Error('Invalid domain: cannot be just a dot');
  }

  // Patterns with too many wildcard segments are too broad.
  // e.g. "*.*.com" has 2 wildcards out of 3 segments → rejected.
  // "*.github.com" has 1 wildcard out of 3 segments → fine.
  const segments = trimmed.split('.');
  const wildcardSegments = segments.filter(s => s === '*').length;
  const totalSegments = segments.length;

  if (wildcardSegments > 1 && wildcardSegments >= totalSegments - 1) {
    throw new Error(
      `Pattern '${trimmed}' has too many wildcard segments and is not allowed`
    );
  }
}

/**
 * Validate a domain or wildcard pattern
 *
 * Performs five security checks in sequence, each isolated in a named helper
 * to make the validation logic easy to audit:
 *  1. Empty-input check
 *  2. Dangerous-character detection (Squid injection prevention)
 *  3. Over-broad wildcard rejection (`*`, `*.*`, patterns of only `*`/`.`)
 *  4. Double-dot rejection
 *  5. Invalid lone-dot and excessive-wildcard-segment check
 *
 * @param input - Domain or pattern to validate (may include protocol prefix)
 * @throws Error if the input is invalid or too broad
 */
export function validateDomainOrPattern(input: string): void {
  if (!input || input.trim() === '') {
    throw new Error('Domain cannot be empty');
  }

  // Strip protocol prefix so remaining checks operate on the bare domain/pattern
  const parsed = parseDomainWithProtocol(input);
  const trimmed = parsed.domain;

  if (!trimmed || trimmed === '') {
    throw new Error('Domain cannot be empty');
  }

  checkDangerousChars(trimmed);
  checkOverBroadPattern(trimmed);
  checkStructuralValidity(trimmed);
}
