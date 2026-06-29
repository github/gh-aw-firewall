/**
 * GitHub platform deployment type and runner topology options.
 */

export type RunnerTopology = 'standard' | 'arc-dind';

export interface PlatformOptions {
  /**
   * The GitHub deployment type. Explicitly declares the environment so AWF can
   * apply correct auth behavior (e.g. 'token' vs 'Bearer' prefix for Copilot API)
   * without relying on heuristic detection from GITHUB_SERVER_URL.
   *
   * - 'github.com' — GitHub.com (default)
   * - 'ghes' — GitHub Enterprise Server (on-premises)
   * - 'ghec' — GitHub Enterprise Cloud (*.ghe.com tenants)
   * - 'ghec-self-hosted' — GHEC with self-hosted runners
   *
   * When set to 'ghes', the api-proxy uses 'token' prefix for Copilot auth
   * regardless of the resolved API target hostname.
   */
  platformType?: 'github.com' | 'ghes' | 'ghec' | 'ghec-self-hosted';

  /**
   * Runner deployment topology.
   *
   * - 'standard' (default) — GitHub-hosted VM or self-hosted runner with local Docker.
   * - 'arc-dind' — ARC (Actions Runner Controller) with Docker-in-Docker sidecar,
   *   where the runner and Docker daemon have separate filesystems.
   *
   * When set to 'arc-dind', AWF applies overridable defaults:
   *   - network.isolation = true (ARC k8s lacks NET_ADMIN)
   *   - dind.preStageDirs = true
   *   - Sysroot image activation (build-tools init container)
   *   - Tool cache validation (warns if under /opt)
   */
  runnerTopology?: RunnerTopology;

  /**
   * Container image providing system-level build tools (gcc, make, libraries)
   * for the agent's chroot base on ARC/DinD.
   *
   * Used as an init container that copies its filesystem into a named volume
   * mounted at /host. Only used when runnerTopology is 'arc-dind'.
   *
   * Defaults to 'ghcr.io/github/gh-aw-firewall/build-tools:<imageTag>'.
   */
  sysrootImage?: string;
}
