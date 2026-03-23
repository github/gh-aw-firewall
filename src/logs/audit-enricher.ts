/**
 * Enriches parsed log entries with policy rule matching information.
 *
 * Given a PolicyManifest and parsed log entries, this module determines which
 * firewall rule caused each allow/deny decision by replaying the ACL evaluation
 * order. Squid evaluates http_access rules top-to-bottom, applying the first match.
 */

import { ParsedLogEntry, PolicyManifest, PolicyRule } from '../types';

/**
 * A log entry enriched with the policy rule that matched it.
 */
export interface EnrichedLogEntry extends ParsedLogEntry {
  /** ID of the policy rule that matched (e.g., "allow-both-plain", "deny-default") */
  matchedRuleId: string;
  /** Human-readable reason for the decision */
  matchReason: string;
}

/**
 * Per-rule hit statistics.
 */
export interface RuleStats {
  ruleId: string;
  description: string;
  action: 'allow' | 'deny';
  hits: number;
}

/**
 * Checks whether a domain matches any entry in a rule's domain list.
 *
 * For plain domain rules (dstdomain), domains are listed as ".github.com"
 * which matches both "github.com" and "*.github.com".
 *
 * For regex rules (dstdom_regex), domains are listed as regex patterns.
 */
function domainMatchesRule(domain: string, rule: PolicyRule): boolean {
  if (!domain || domain === '-') return false;

  const lowerDomain = domain.toLowerCase();

  // Detect regex rules: either the ACL name contains "regex", or the domain
  // entries contain regex metacharacters (e.g., dst_ipv4 uses ^[0-9]+ patterns)
  const isRegexRule = rule.aclName.includes('regex') ||
    rule.domains.some(d => /[\\^$*+?{}()[\]|]/.test(d));

  for (const entry of rule.domains) {
    if (isRegexRule) {
      // Regex match
      try {
        const re = new RegExp(entry, 'i');
        if (re.test(lowerDomain)) return true;
      } catch {
        // Invalid regex, skip
      }
    } else {
      // Plain domain match: ".github.com" matches "github.com" and "api.github.com"
      const aclDomain = entry.toLowerCase();
      if (aclDomain.startsWith('.')) {
        const baseDomain = aclDomain.slice(1);
        if (lowerDomain === baseDomain || lowerDomain.endsWith(aclDomain)) {
          return true;
        }
      } else {
        if (lowerDomain === aclDomain) return true;
      }
    }
  }

  return false;
}

/**
 * Checks whether a rule's protocol constraint matches the request.
 */
function protocolMatches(rule: PolicyRule, isHttps: boolean): boolean {
  if (rule.protocol === 'both') return true;
  if (rule.protocol === 'https' && isHttps) return true;
  if (rule.protocol === 'http' && !isHttps) return true;
  return false;
}

/**
 * Finds the first matching policy rule for a log entry by replaying
 * the http_access evaluation order.
 *
 * Only returns rules whose action is consistent with the observed decision
 * (entry.isAllowed). Rules with empty domains (port/method-based rules like
 * deny-unsafe-ports) cannot be deterministically replayed from log data alone,
 * so they are skipped — the caller treats unmatched entries as "unknown".
 */
function findMatchingRule(entry: ParsedLogEntry, rules: PolicyRule[]): PolicyRule | null {
  const expectedAction: 'allow' | 'deny' = entry.isAllowed ? 'allow' : 'deny';

  for (const rule of rules) {
    if (!protocolMatches(rule, entry.isHttps)) continue;

    // The default deny rule (aclName: "all") matches everything denied
    if (rule.aclName === 'all') {
      if (expectedAction === 'deny') return rule;
      continue;
    }

    // Rules with no domains (port safety, DLP, etc.) can't be replayed
    // from log data alone — skip to avoid misleading attribution
    if (!rule.domains || rule.domains.length === 0) continue;

    if (!domainMatchesRule(entry.domain, rule)) continue;

    // Only attribute if the rule's action matches the observed outcome
    if (rule.action === expectedAction) return rule;
  }

  return null;
}

/**
 * Enriches parsed log entries with policy rule matching.
 *
 * For each entry, replays the ACL evaluation order from the manifest
 * to determine which rule caused the allow/deny decision.
 */
export function enrichWithPolicyRules(
  entries: ParsedLogEntry[],
  manifest: PolicyManifest
): EnrichedLogEntry[] {
  // Sort rules by evaluation order
  const sortedRules = [...manifest.rules].sort((a, b) => a.order - b.order);

  return entries.map(entry => {
    const matchedRule = findMatchingRule(entry, sortedRules);

    if (matchedRule) {
      return {
        ...entry,
        matchedRuleId: matchedRule.id,
        matchReason: matchedRule.description,
      };
    }

    // Fallback: no rule matched (shouldn't happen with a deny-default rule)
    return {
      ...entry,
      matchedRuleId: 'unknown',
      matchReason: entry.isAllowed ? 'Allowed (rule not identified)' : 'Denied (rule not identified)',
    };
  });
}

/**
 * Computes per-rule hit statistics from enriched log entries.
 */
export function computeRuleStats(
  enrichedEntries: EnrichedLogEntry[],
  manifest: PolicyManifest
): RuleStats[] {
  const hitCounts = new Map<string, number>();

  for (const entry of enrichedEntries) {
    // Skip benign operational entries
    if (entry.url === 'error:transaction-end-before-headers') continue;
    hitCounts.set(entry.matchedRuleId, (hitCounts.get(entry.matchedRuleId) || 0) + 1);
  }

  const manifestStats: RuleStats[] = manifest.rules.map(rule => ({
    ruleId: rule.id,
    description: rule.description,
    action: rule.action,
    hits: hitCounts.get(rule.id) || 0,
  }));

  // Include unattributed traffic so per-rule totals reconcile with overall totals
  const unknownHits = hitCounts.get('unknown') || 0;
  if (unknownHits > 0) {
    manifestStats.push({
      ruleId: 'unknown',
      description: 'Unattributed traffic (port/method-based rules not replayable from logs)',
      action: 'deny',
      hits: unknownHits,
    });
  }

  return manifestStats;
}
