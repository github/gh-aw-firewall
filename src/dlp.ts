/**
 * Data Loss Prevention (DLP) module for detecting credential patterns
 * in outbound HTTP/HTTPS traffic.
 *
 * When DLP is enabled, Squid proxy URL regex ACLs block requests that
 * contain credential-like patterns in URLs (query parameters, path segments,
 * headers passed via URL encoding, etc.).
 *
 * This protects against accidental credential leakage in:
 * - URL query parameters (e.g., ?token=ghp_xxxx)
 * - URL path segments (e.g., /api/ghp_xxxx/resource)
 * - Encoded credentials in URLs
 */

/**
 * A DLP credential pattern definition
 */
export interface DlpPattern {
  /** Human-readable name for the pattern */
  name: string;
  /** Description of what this pattern detects */
  description: string;
  /** Regex pattern string (Squid url_regex compatible, case-insensitive) */
  regex: string;
}

/**
 * Built-in credential patterns for DLP scanning
 *
 * These patterns detect common credential formats that should never
 * appear in URLs. Each regex is designed to be used with Squid's
 * url_regex ACL type (POSIX extended regex, case-insensitive).
 *
 * Pattern design principles:
 * - Match the distinctive prefix of each credential type
 * - Require enough characters after the prefix to avoid false positives
 * - Use case-insensitive matching where appropriate
 * - Avoid overly broad patterns that would block legitimate traffic
 */
export const DLP_PATTERNS: DlpPattern[] = [
  // GitHub tokens
  {
    name: 'GitHub Personal Access Token (classic)',
    description: 'GitHub classic personal access token (ghp_)',
    regex: 'ghp_[a-zA-Z0-9]{36}',
  },
  {
    name: 'GitHub OAuth Access Token',
    description: 'GitHub OAuth access token (gho_)',
    regex: 'gho_[a-zA-Z0-9]{36}',
  },
  {
    name: 'GitHub App Installation Token',
    description: 'GitHub App installation access token (ghs_)',
    regex: 'ghs_[a-zA-Z0-9]{36}',
  },
  {
    name: 'GitHub App User-to-Server Token',
    description: 'GitHub App user-to-server token (ghu_)',
    regex: 'ghu_[a-zA-Z0-9]{36}',
  },
  {
    name: 'GitHub Fine-Grained PAT',
    description: 'GitHub fine-grained personal access token (github_pat_)',
    regex: 'github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}',
  },

  // OpenAI
  {
    name: 'OpenAI API Key',
    description: 'OpenAI API key (sk-)',
    regex: 'sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}',
  },
  {
    name: 'OpenAI Project API Key',
    description: 'OpenAI project-scoped API key (sk-proj-)',
    regex: 'sk-proj-[a-zA-Z0-9_-]{40,}',
  },

  // Anthropic
  {
    name: 'Anthropic API Key',
    description: 'Anthropic API key (sk-ant-)',
    regex: 'sk-ant-[a-zA-Z0-9_-]{40,}',
  },

  // AWS
  {
    name: 'AWS Access Key ID',
    description: 'AWS access key ID (AKIA)',
    regex: 'AKIA[0-9A-Z]{16}',
  },

  // Google Cloud
  {
    name: 'Google API Key',
    description: 'Google API key (AIza)',
    regex: 'AIza[a-zA-Z0-9_-]{35}',
  },

  // Slack
  {
    name: 'Slack Bot Token',
    description: 'Slack bot user OAuth token (xoxb-)',
    regex: 'xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}',
  },
  {
    name: 'Slack User Token',
    description: 'Slack user OAuth token (xoxp-)',
    regex: 'xoxp-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[a-f0-9]{32}',
  },

  // Generic patterns for common credential formats
  {
    name: 'Bearer Token in URL',
    description: 'Bearer token passed as URL parameter',
    regex: '[?&]bearer[_=][a-zA-Z0-9._-]{20,}',
  },
  {
    name: 'Authorization in URL',
    description: 'Authorization credential passed as URL parameter',
    regex: '[?&]authorization=[a-zA-Z0-9._-]{20,}',
  },
  {
    name: 'Private Key Marker',
    description: 'Private key content in URL (PEM format marker)',
    regex: 'PRIVATE(%20|\\+|%2B)KEY',
  },
];

/**
 * Checks if a given string contains any DLP credential patterns.
 *
 * @param input - The string to scan (URL, query parameter, etc.)
 * @returns Array of matched pattern names, empty if no matches
 */
export function scanForCredentials(input: string): string[] {
  const matches: string[] = [];
  for (const pattern of DLP_PATTERNS) {
    const regex = new RegExp(pattern.regex, 'i');
    if (regex.test(input)) {
      matches.push(pattern.name);
    }
  }
  return matches;
}

/**
 * Generates Squid ACL configuration lines for DLP credential scanning.
 *
 * Produces `url_regex` ACL entries that match credential patterns in URLs,
 * plus `http_access deny` rules that block matching requests.
 *
 * The deny rules are placed before allow rules in the generated squid.conf
 * to ensure credential-bearing requests are blocked regardless of domain
 * allowlist status.
 *
 * @returns Object with aclLines and accessRules arrays
 */
export function generateDlpSquidConfig(): { aclLines: string[]; accessRules: string[] } {
  const aclLines: string[] = [
    '# DLP (Data Loss Prevention) ACL definitions',
    '# Block requests containing credential patterns in URLs',
  ];

  for (const pattern of DLP_PATTERNS) {
    aclLines.push(`acl dlp_blocked url_regex -i ${pattern.regex}`);
  }

  const accessRules: string[] = [
    '# DLP: Deny requests containing detected credentials',
    'http_access deny dlp_blocked',
  ];

  return { aclLines, accessRules };
}
