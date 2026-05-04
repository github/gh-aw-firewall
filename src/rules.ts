/**
 * YAML rule configuration support for domain allowlisting.
 *
 * Provides structured rule syntax via YAML files that can be loaded
 * with --ruleset-file and merged with --allow-domains.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';

/**
 * A single domain rule within a ruleset
 */
interface Rule {
  /** Domain name to allow (e.g., "github.com") */
  domain: string;
  /**
   * Whether to also allow all subdomains of this domain.
   * When true, both "example.com" and ".example.com" are added.
   * @default true
   */
  subdomains?: boolean;
}

/**
 * Top-level structure of a YAML ruleset file
 */
export interface RuleSet {
  /** Schema version (must be 1) */
  version: number;
  /** Array of domain rules */
  rules: Rule[];
}

/**
 * Loads and validates a YAML ruleset file.
 *
 * @param filePath - Path to the YAML ruleset file
 * @returns Parsed and validated RuleSet
 * @throws Error if the file doesn't exist, contains invalid YAML, or fails validation
 */
export function loadRuleSet(filePath: string): RuleSet {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Ruleset file not found: ${filePath}`);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read ruleset file ${filePath}: ${err instanceof Error ? err.message : err}`
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ruleset file ${filePath}: ${err instanceof Error ? err.message : err}`
    );
  }

  if (parsed === null || parsed === undefined) {
    throw new Error(`Ruleset file ${filePath} is empty`);
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Ruleset file ${filePath} must contain a YAML object with "version" and "rules" fields`
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Validate version
  if (!('version' in obj)) {
    throw new Error(`Ruleset file ${filePath} is missing required "version" field`);
  }
  if (obj.version !== 1) {
    throw new Error(
      `Unsupported ruleset version ${obj.version} in ${filePath} (expected 1)`
    );
  }

  // Validate rules
  if (!('rules' in obj)) {
    throw new Error(`Ruleset file ${filePath} is missing required "rules" field`);
  }
  if (!Array.isArray(obj.rules)) {
    throw new Error(`"rules" field in ${filePath} must be an array`);
  }

  const rules: Rule[] = [];
  for (let i = 0; i < obj.rules.length; i++) {
    const rule = obj.rules[i];
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error(
        `Rule at index ${i} in ${filePath} must be an object with a "domain" field`
      );
    }

    const ruleObj = rule as Record<string, unknown>;

    if (!('domain' in ruleObj) || typeof ruleObj.domain !== 'string') {
      throw new Error(
        `Rule at index ${i} in ${filePath} is missing required "domain" string field`
      );
    }

    const domain = ruleObj.domain.trim();
    if (domain.length === 0) {
      throw new Error(`Rule at index ${i} in ${filePath} has an empty "domain" field`);
    }

    let subdomains = true; // default
    if ('subdomains' in ruleObj) {
      if (typeof ruleObj.subdomains !== 'boolean') {
        throw new Error(
          `Rule at index ${i} in ${filePath}: "subdomains" must be a boolean`
        );
      }
      subdomains = ruleObj.subdomains;
    }

    rules.push({ domain, subdomains });
  }

  return { version: 1, rules };
}

/**
 * Expands a single rule into domain strings suitable for the allowedDomains list.
 *
 * When subdomains is true (default), the domain is returned as-is because the
 * existing domain normalization in squid-config.ts and domain-patterns.ts
 * automatically adds subdomain matching (both "example.com" and ".example.com").
 *
 * When subdomains is false, the domain is prefixed with "exact:" to signal
 * exact-match-only behavior. However, since the current squid config always
 * adds subdomain matching, we return just the bare domain. The subdomain
 * field is reserved for future granular control.
 *
 * @param rule - A single domain rule
 * @returns Array of domain strings
 */
export function expandRule(rule: Rule): string[] {
  // The existing system already handles subdomain matching when a plain
  // domain is provided (e.g., "github.com" matches both github.com and
  // *.github.com in Squid config). So we just return the domain.
  return [rule.domain];
}

/**
 * Merges multiple rulesets into a single deduplicated list of domain strings.
 *
 * @param ruleSets - Array of parsed RuleSet objects
 * @returns Array of unique domain strings
 */
export function mergeRuleSets(ruleSets: RuleSet[]): string[] {
  const domains = new Set<string>();

  for (const ruleSet of ruleSets) {
    for (const rule of ruleSet.rules) {
      for (const domain of expandRule(rule)) {
        domains.add(domain);
      }
    }
  }

  return [...domains];
}

/**
 * Loads multiple ruleset files and merges them with CLI domains.
 *
 * @param rulesetFiles - Array of file paths to YAML ruleset files
 * @param cliDomains - Domains already provided via --allow-domains
 * @returns Deduplicated array of all domain strings
 */
export function loadAndMergeDomains(
  rulesetFiles: string[],
  cliDomains: string[]
): string[] {
  const ruleSets = rulesetFiles.map(f => loadRuleSet(f));
  const rulesetDomains = mergeRuleSets(ruleSets);
  const allDomains = [...cliDomains, ...rulesetDomains];
  return [...new Set(allDomains)];
}
