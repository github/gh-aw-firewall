/**
 * Shared container security-hardening helpers.
 *
 * Centralises the `cap_drop`, `security_opt`, and resource-limit fields that
 * must be applied uniformly to every sidecar service built by the firewall.
 * Using a single helper means a future hardening change (e.g. adding
 * `read_only: true`) propagates to all sidecars automatically.
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
 * Returns the standard security-hardening fields for a sidecar service.
 *
 * The `cap_drop` and `security_opt` values are identical for every sidecar;
 * only the resource limits vary per service.
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
