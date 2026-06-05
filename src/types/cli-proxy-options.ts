/**
 * CLI proxy sidecar configuration options.
 */

export interface CliProxyOptions {
  /**
   * Enable CLI proxy sidecar for secure gh CLI access
   *
   * When true, deploys a CLI proxy sidecar container that:
   * - Routes gh CLI invocations through an external DIFC proxy (mcpg)
   * - The DIFC proxy enforces guard policies (min-integrity, repo restrictions)
   * - Generates audit logs via mcpg's JSONL output
   *
   * The agent container gets a /usr/local/bin/gh wrapper script that
   * forwards invocations to the CLI proxy sidecar at http://172.30.0.50:11000.
   *
   * The DIFC proxy (mcpg) is started externally by the gh-aw compiler on the
   * host. AWF only launches the cli-proxy container and connects it to the
   * external DIFC proxy via a TCP tunnel for TLS hostname matching.
   *
   * @example 'host.docker.internal:18443'
   */
  difcProxyHost?: string;

  /**
   * Path to the TLS CA certificate written by the external DIFC proxy.
   *
   * The DIFC proxy generates a self-signed TLS cert. This path points to
   * the CA cert on the host filesystem, which is bind-mounted into the
   * cli-proxy container for TLS verification.
   *
   * @example '/tmp/gh-aw/difc-proxy-tls/ca.crt'
   */
  difcProxyCaCert?: string;

  /**
   * GitHub token for the CLI proxy sidecar
   *
   * When difcProxyHost is set, GitHub tokens are excluded from the agent
   * container environment. The token is held by the external DIFC proxy.
   *
   * Read from GITHUB_TOKEN environment variable when not specified.
   *
   * @default undefined
   */
  githubToken?: string;
}
