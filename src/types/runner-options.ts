/**
 * Runner topology configuration options.
 */
export interface RunnerOptions {
  /**
   * Runner topology mode for AWF compose generation.
   *
   * - 'standard' (default) - GitHub-hosted VM or self-hosted runner with local Docker.
   * - 'arc-dind' - ARC with Docker-in-Docker sidecar, enables sysroot staging
   *   for split runner/daemon filesystems.
   */
  runnerTopology?: 'standard' | 'arc-dind';

  /**
   * Sysroot image used by arc-dind topology to stage build tools into /host.
   *
   * @default 'ghcr.io/github/gh-aw-firewall/build-tools:latest'
   */
  sysrootImage?: string;
}
