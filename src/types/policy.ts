/**
 * Policy types for the agentic workflow firewall
 */

/**
 * A single firewall policy rule as evaluated by Squid's http_access directives.
 *
 * Rules are evaluated in order; the first matching rule determines the outcome.
 */
export interface PolicyRule {
  /** Unique identifier for this rule (e.g., "deny-blocked-plain", "allow-both-plain") */
  id: string;
  /** Evaluation order (1-based, matching http_access line order) */
  order: number;
  /** Whether this rule allows or denies traffic */
  action: 'allow' | 'deny';
  /** Squid ACL name or expression (e.g., "allowed_domains", "!Safe_ports", "dst_ipv4"). Not always a single ACL name — may include negation or method constraints for port/method-based rules. */
  aclName: string;
  /** Protocol scope: 'http' (non-CONNECT), 'https' (CONNECT), or 'both' */
  protocol: 'http' | 'https' | 'both';
  /** Domain values in this ACL (plain domains or regex patterns) */
  domains: string[];
  /** Human-readable description of this rule */
  description: string;
}

/**
 * Structured representation of the firewall policy in effect for a run.
 *
 * Written to policy-manifest.json in the audit directory. Combined with
 * Squid access logs, this enables deterministic "which rule matched?"
 * analysis by replaying ACL evaluation order.
 */
export interface PolicyManifest {
  /** Schema version for forward compatibility */
  version: 1;
  /** ISO timestamp when this manifest was generated */
  generatedAt: string;
  /** Ordered list of http_access rules (evaluated first-to-last) */
  rules: PolicyRule[];
  /**
   * TCP ports treated as "dangerous" by the firewall policy.
   *
   * Derived from the Squid configuration (DANGEROUS_PORTS) used by the wrapper.
   * Documents which ports are considered unsafe for direct proxying. May not be
   * an exact reflection of the iptables rules installed in the agent container.
   */
  dangerousPorts: number[];
  /** DNS servers configured for the agent */
  dnsServers: string[];
  /** Whether SSL Bump (HTTPS inspection) is enabled */
  sslBumpEnabled: boolean;
  /** Whether DLP scanning is enabled */
  dlpEnabled: boolean;
  /** Whether host access is enabled */
  hostAccessEnabled: boolean;
  /** Additional allowed ports (from --allow-host-ports), if any */
  allowHostPorts: string | null;
}
