/**
 * Security-hardening helpers for unprivileged proxy sidecar containers.
 *
 * This module centralises the `cap_drop`, `security_opt`, and resource-limit
 * fields shared by the lightweight proxy sidecars (api-proxy, cli-proxy,
 * doh-proxy) that run without any Linux capabilities.
 *
 * Note: other services such as `squid-service` and `agent-service` have
 * different hardening requirements (custom cap_drop sets, seccomp profiles,
 * AppArmor options) and should NOT use this helper.
 *
 * Using a single helper means a future hardening change (e.g. adding
 * `read_only: true`) propagates to all three proxy sidecars automatically.
 */

interface ContainerResourceLimits {
  /** Maximum memory for the container (Docker memory format, e.g. '512m'). */
  memLimit: string;
  /** Maximum number of processes/threads the container may create. */
  pidsLimit: number;
  /**
   * Relative CPU weight (cpu_shares).
   * If omitted the field is not included in the output.
   */
  cpuShares?: number;
}

/**
 * Returns the standard security-hardening fields for an unprivileged proxy
 * sidecar (api-proxy, cli-proxy, doh-proxy).
 *
 * `cap_drop: ['ALL']` and `security_opt: ['no-new-privileges:true']` are
 * fixed; resource limits are caller-supplied because they differ per service.
 *
 * @example
 * ```ts
 * const service = {
 *   ...buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100, cpuShares: 512 }),
 *   // other service-specific fields
 * };
 * ```
 */
export function buildContainerSecurityHardening(limits: ContainerResourceLimits): Record<string, unknown> {
  return {
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: limits.memLimit,
    memswap_limit: limits.memLimit,
    pids_limit: limits.pidsLimit,
    ...(limits.cpuShares !== undefined && { cpu_shares: limits.cpuShares }),
  };
}
