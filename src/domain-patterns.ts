/**
 * Domain pattern utilities for wildcard support in --allow-domains
 *
 * Low-level utilities and shared types used across domain validation and matching.
 *
 * Supports asterisk (*) wildcards that are converted to Squid dstdom_regex ACLs.
 * Examples:
 *   *.github.com      -> matches api.github.com, raw.github.com, etc.
 *   api-*.example.com -> matches api-v1.example.com, api-test.example.com, etc.
 *
 * Also supports protocol-specific domain allowlisting:
 *   http://github.com  -> allow only HTTP traffic (port 80)
 *   https://github.com -> allow only HTTPS traffic (port 443)
 *   github.com         -> allow both HTTP and HTTPS (default)
 */

/**
 * Protocol restriction for a domain
 */
export type DomainProtocol = 'http' | 'https' | 'both';

/**
 * Parsed domain with protocol information
 */
export interface ParsedDomain {
  /** The domain name without protocol prefix */
  domain: string;
  /** Which protocol(s) are allowed */
  protocol: DomainProtocol;
}

/**
 * Parse a domain string and extract protocol restriction if present
 *
 * @param input - Domain string, optionally prefixed with http:// or https://
 * @returns ParsedDomain with the domain and protocol restriction
 *
 * Examples:
 *   'github.com'        -> { domain: 'github.com', protocol: 'both' }
 *   'http://github.com' -> { domain: 'github.com', protocol: 'http' }
 *   'https://github.com' -> { domain: 'github.com', protocol: 'https' }
 */
export function parseDomainWithProtocol(input: string): ParsedDomain {
  const trimmed = input.trim();

  if (trimmed.startsWith('http://')) {
    return {
      domain: trimmed.slice(7).replace(/\/$/, ''),
      protocol: 'http',
    };
  }

  if (trimmed.startsWith('https://')) {
    return {
      domain: trimmed.slice(8).replace(/\/$/, ''),
      protocol: 'https',
    };
  }

  // No protocol prefix - allow both
  return {
    domain: trimmed.replace(/\/$/, ''),
    protocol: 'both',
  };
}

/**
 * Check if a domain string contains wildcard characters
 */
export function isWildcardPattern(domain: string): boolean {
  return domain.includes('*');
}

/**
 * Regex pattern for matching valid domain name characters.
 * Uses character class instead of .* to prevent catastrophic backtracking (ReDoS).
 * Per RFC 1035, valid domain characters are: letters, digits, hyphens, and dots.
 */
const DOMAIN_CHAR_PATTERN = '[a-zA-Z0-9.-]*';

/**
 * Convert a wildcard pattern to a Squid-compatible regex pattern
 *
 * @param pattern - Domain pattern with asterisk wildcards
 * @returns Anchored regex string for use with dstdom_regex
 * @throws Error if pattern is invalid
 *
 * Conversion rules:
 * - `*` becomes `[a-zA-Z0-9.-]*` (match valid domain characters, safe from ReDoS)
 * - `.` becomes `\.` (literal dot)
 * - Other regex metacharacters are escaped
 * - Result is anchored with `^` and `$`
 */
export function wildcardToRegex(pattern: string): string {
  // Escape regex metacharacters except for *
  // Order matters: escape backslash first
  let regex = '';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    switch (char) {
      case '*':
        // Use character class instead of .* to prevent catastrophic backtracking
        regex += DOMAIN_CHAR_PATTERN;
        break;
      case '.':
        regex += '\\.';
        break;
      // Escape other regex metacharacters
      case '^':
      case '$':
      case '+':
      case '?':
      case '{':
      case '}':
      case '[':
      case ']':
      case '|':
      case '(':
      case ')':
      case '\\':
        regex += '\\' + char;
        break;
      default:
        regex += char;
        break;
    }
  }

  // Anchor the regex to match the full domain
  return '^' + regex + '$';
}

export interface DomainPattern {
  original: string;
  regex: string;
  protocol: DomainProtocol;
}

/**
 * A plain domain entry with protocol restriction
 */
export interface PlainDomainEntry {
  domain: string;
  protocol: DomainProtocol;
}
