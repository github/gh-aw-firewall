/**
 * Security configuration options.
 */

export interface SecurityOptions {
  /**
   * Whether to enable SSL Bump for HTTPS content inspection
   *
   * When true, Squid will intercept HTTPS connections and generate
   * per-host certificates on-the-fly, allowing inspection of URL paths,
   * query parameters, and request methods for HTTPS traffic.
   *
   * Security implications:
   * - A per-session CA certificate is generated (valid for 1 day)
   * - The CA certificate is injected into the agent container's trust store
   * - HTTPS traffic is decrypted at the proxy for inspection
   * - The CA private key is stored only in the temporary work directory
   *
   * @default false
   */
  sslBump?: boolean;

  /**
   * Enable Docker-in-Docker by exposing the host Docker socket
   *
   * When true, the host's Docker socket (/var/run/docker.sock) is mounted
   * into the agent container, allowing the agent to run Docker commands.
   *
   * WARNING: This allows the agent to bypass firewall restrictions by
   * spawning new containers without network restrictions.
   *
   * @default false
   */
  enableDind?: boolean;

  /**
   * Memory limit for the agent execution container
   *
   * Accepts Docker memory format: a positive integer followed by a unit suffix
   * (b, k, m, g). Controls the maximum amount of memory the container can use.
   *
   * @default '6g'
   * @example '4g'
   * @example '512m'
   */
  memoryLimit?: string;

  /**
   * Enable Data Loss Prevention (DLP) scanning
   *
   * When true, Squid proxy will block outgoing requests that contain
   * credential-like patterns (API keys, tokens, secrets) in URLs.
   * This protects against accidental credential exfiltration via
   * query parameters, path segments, or encoded URL content.
   *
   * Detected patterns include: GitHub tokens (ghp_, gho_, ghs_, ghu_,
   * github_pat_), OpenAI keys (sk-), Anthropic keys (sk-ant-),
   * AWS access keys (AKIA), Google API keys (AIza), Slack tokens,
   * and generic credential patterns.
   *
   * @default false
   */
  enableDlp?: boolean;

  /**
   * Security mode that bundles related security settings.
   *
   * - `'strict'` (default): Enforces network-isolation (Docker network topology),
   *   API proxy (credential injection), and rejects host-access / DinD passthrough.
   *   Incompatible options passed via CLI or config are overridden with warnings.
   *
   * - `'compat'`: Preserves the legacy iptables-based configuration. Allows
   *   host-access, DinD, and direct credential passing. Requires sudo/NET_ADMIN.
   *
   * @default 'strict'
   */
  securityMode?: 'strict' | 'compat';
}
