/**
 * Volume and path configuration options.
 */

export interface VolumeOptions {
  /**
   * Temporary work directory for configuration files and logs
   * 
   * This directory contains:
   * - squid.conf: Generated Squid proxy configuration
   * - docker-compose.yml: Docker Compose service definitions
   * - agent-logs/: Volume mount for agent logs
   * - squid-logs/: Volume mount for Squid proxy logs
   * 
   * @example '/tmp/awf-1234567890'
   */
  workDir: string;

  /**
   * Custom volume mounts to add to the agent execution container
   *
   * Array of volume mount specifications in Docker format:
   * - 'host_path:container_path' (defaults to rw)
   * - 'host_path:container_path:ro' (read-only)
   * - 'host_path:container_path:rw' (read-write)
   *
   * When specified, selective mounting is used (only essential directories + custom mounts).
   * When not specified, selective mounting is still used by default for security.
   *
   * @example ['/workspace:/workspace:ro', '/data:/data:rw']
   */
  volumeMounts?: string[];

  /**
   * Working directory inside the agent execution container
   *
   * Sets the initial working directory (pwd) for command execution.
   * This overrides the Dockerfile's WORKDIR and should match GITHUB_WORKSPACE
   * for path consistency with AI prompts.
   *
   * When not specified, defaults to the container's WORKDIR (/workspace).
   *
   * @example '/home/runner/work/repo/repo'
   */
  containerWorkDir?: string;

  /**
   * Custom directory for Squid proxy logs (written directly during runtime)
   *
   * When specified, Squid proxy logs (access.log, cache.log) are written
   * directly to this directory during execution via Docker volume mount.
   * This is timeout-safe: logs are available immediately and survive
   * unexpected termination (SIGKILL).
   *
   * When not specified, logs are written to ${workDir}/squid-logs during
   * runtime and moved to /tmp/squid-logs-<timestamp> after cleanup.
   *
   * Note: This only affects Squid proxy logs. Agent logs (e.g., from
   * Copilot CLI --log-dir) are handled separately and always preserved
   * to /tmp/awf-agent-logs-<timestamp>.
   *
   * @example '/tmp/my-proxy-logs'
   */
  proxyLogsDir?: string;

  /**
   * Directory for firewall audit artifacts (configs, policy manifest, iptables state)
   *
   * When specified, audit artifacts are written directly to this directory
   * during execution. This is useful for CI/CD where you want a predictable
   * path for artifact upload.
   *
   * When not specified, audit artifacts are written to ${workDir}/audit/
   * during runtime and moved to /tmp/awf-audit-<timestamp> after cleanup.
   *
   * Artifacts include:
   * - squid.conf: The generated Squid proxy configuration
   * - docker-compose.redacted.yml: Container orchestration config (secrets redacted)
   * - policy-manifest.json: Structured description of all firewall rules
   * - iptables-audit.txt: Captured iptables state from the agent container
   *
   * Can be set via:
   * - CLI flag: `--audit-dir <path>`
   * - Environment variable: `AWF_AUDIT_DIR`
   *
   * @example '/tmp/gh-aw/sandbox/firewall/audit'
   */
  auditDir?: string;

  /**
   * Directory for agent session state (Copilot CLI events.jsonl, session data)
   *
   * When specified, the session-state volume is written directly to this
   * directory during execution, making it timeout-safe and available at a
   * predictable path for artifact upload.
   *
   * When not specified, session state is written to ${workDir}/agent-session-state
   * during runtime and moved to /tmp/awf-agent-session-state-<timestamp> after cleanup.
   *
   * Can be set via:
   * - CLI flag: `--session-state-dir <path>`
   * - Environment variable: `AWF_SESSION_STATE_DIR`
   *
   * @example '/tmp/gh-aw/sandbox/agent/session-state'
   */
  sessionStateDir?: string;

  /**
   * Host runner tool cache directory to mount read-only into chroot mode.
   *
   * When specified, AWF prefers this path over auto-detection and mounts it as:
   * `<path>:/host<path>:ro` if the host path exists and is a real directory.
   *
   * Primarily intended for stdin config usage where shell interpolation of
   * `RUNNER_TOOL_CACHE` is unavailable.
   *
   * @example '/opt/hostedtoolcache'
   */
  runnerToolCachePath?: string;

  /**
   * Enable diagnostic log collection on non-zero exit
   *
   * When true and AWF exits with a non-zero exit code, container stdout/stderr
   * logs, state metadata, and a sanitized docker-compose.yml are written to
   * `${workDir}/diagnostics/` before containers are stopped.  When `auditDir`
   * is also set the diagnostics are co-located there as `${auditDir}/diagnostics/`.
   *
   * Collected artifacts:
   * - `<container>.log`: stdout+stderr from `docker logs`
   * - `<container>.state`: exit code and error string from `docker inspect`
   * - `<container>.mounts.json`: volume mount info from `docker inspect`
   * - `docker-compose.yml`: generated compose file with TOKEN/KEY/SECRET values redacted
   *
   * Containers inspected: awf-squid, awf-agent, awf-api-proxy, awf-iptables-init.
   * Containers that never started (e.g. api-proxy when not enabled) are silently skipped.
   *
   * Off by default. Enable via `--diagnostic-logs` CLI flag or the
   * `features.awf-diagnostic-logs: true` workflow frontmatter key.
   *
   * @default false
   */
  diagnosticLogs?: boolean;
}
