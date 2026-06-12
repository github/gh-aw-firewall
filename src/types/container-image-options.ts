/**
 * Container image configuration options.
 */

export interface ContainerImageOptions {
  /**
   * Docker image registry to use for container images
   * 
   * Allows overriding the default GitHub Container Registry with custom registries
   * for development, testing, or air-gapped environments.
   * 
   * @default 'ghcr.io/github/gh-aw-firewall'
   * @example 'my-registry.example.com/awf'
   */
  imageRegistry?: string;

  /**
   * Docker image tag to use for container images
   * 
   * @default 'latest'
   * @example 'v0.1.0'
   * @example 'dev'
   */
  imageTag?: string;

  /**
   * Whether to build container images locally instead of pulling from registry
   *
   * When true, Docker images are built from local Dockerfiles in containers/squid
   * and containers/agent directories. When false (default), images are pulled
   * from the configured registry.
   *
   * @default false
   */
  buildLocal?: boolean;

  /**
   * Whether to skip pulling images from the registry
   *
   * When true, Docker Compose will use locally available images without
   * attempting to pull from the registry. This is useful when images are
   * pre-downloaded or in air-gapped environments.
   *
   * If the required images are not available locally, container startup will fail.
   *
   * @default false
   */
  skipPull?: boolean;

  /**
   * Agent container image preset or custom base image
   *
   * Presets (pre-built, fast startup):
   * - 'default' or undefined: Minimal ubuntu:22.04 (~200MB) - uses GHCR agent:tag
   * - 'act': GitHub Actions parity (~2GB) - uses GHCR agent-act:tag
   *
   * Custom base images (require --build-local):
   * - 'ubuntu:XX.XX': Official Ubuntu image
   * - 'ghcr.io/catthehacker/ubuntu:runner-XX.XX': Closer to GitHub Actions runner (~2-5GB)
   * - 'ghcr.io/catthehacker/ubuntu:full-XX.XX': Near-identical to GitHub Actions runner (~20GB)
   *
   * @default 'default'
   * @example 'act'
   * @example 'ghcr.io/catthehacker/ubuntu:runner-22.04'
   */
  agentImage?: 'default' | 'act' | string;

  /**
   * Docker host to use for AWF's own container operations
   *
   * When set, overrides the `DOCKER_HOST` environment variable for all
   * docker CLI calls made by AWF itself (compose up/down, docker wait, etc.).
   *
   * Both unix:// socket paths and loopback TCP endpoints are supported:
   * - `unix:///run/user/1000/docker.sock` — non-default unix socket
   * - `tcp://localhost:2375` — ARC/DinD sidecar (standard RunnerScaleSet config)
   * - `tcp://127.0.0.1:2375` — loopback TCP sidecar
   *
   * When not set, AWF uses the current `DOCKER_HOST` environment variable
   * unchanged.  Loopback TCP and unix:// values are passed through as-is;
   * non-loopback TCP endpoints emit a warning and fall back to the default
   * socket.
   *
   * The original `DOCKER_HOST` value (if any) is forwarded into the agent
   * container so the agent workload can still reach an external DinD daemon.
   * @example 'unix:///var/run/docker.sock'
   * @example 'unix:///run/user/1000/docker.sock'
   * @example 'tcp://localhost:2375'
   */
  awfDockerHost?: string;

  /**
   * Prefix runner-visible bind-mount source paths for Docker daemon resolution
   *
   * Use this when the Docker daemon runs in a different filesystem namespace
   * than the AWF process (for example, ARC + DinD sidecar setups). AWF will
   * prepend this prefix to bind-mount source paths before generating compose.
   *
   * @example '/host'
   */
  dockerHostPathPrefix?: string;
}
