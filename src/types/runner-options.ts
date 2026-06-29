/**
 * Runner topology configuration options.
 */
export interface RunnerOptions {
  /**
   * Runner topology mode for AWF compose generation.
   *
   * `arc-dind` enables sysroot staging for split runner/daemon filesystems.
   */
  runnerTopology?: 'arc-dind';

  /**
   * Sysroot image used by arc-dind topology to stage build tools into /host.
   *
   * @default 'ghcr.io/github/gh-aw-firewall/build-tools:latest'
   */
  runnerSysrootImage?: string;
}
