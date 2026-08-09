import { getLocalDockerEnv } from '../docker-host';
import type { FirecrackerOptions, WrapperConfig } from '../types';

export function assertFirecrackerSelection(config: WrapperConfig): void {
  if (config.firecracker && config.containerRuntime !== 'firecracker') {
    throw new Error(
      'Firecracker options require --container-runtime firecracker',
    );
  }
}

export function assertFirecrackerRuntimeCompatibility(
  config: WrapperConfig,
  firecracker = requireFirecrackerConfig(config),
): void {
  if (!firecracker.previewEnabled) {
    throw new Error(
      'Firecracker workload execution requires explicit --firecracker-preview opt-in',
    );
  }
  if (!config.networkIsolation || config.legacySecurity) {
    throw new Error('Firecracker preview requires strict --network-isolation security');
  }
  if (!config.enableApiProxy) {
    throw new Error('Firecracker preview requires API proxy credential isolation');
  }
  assertFirecrackerPreSecurityCompatibility(config);
  if (!firecracker.kernelPath || !firecracker.rootfsPath || !firecracker.supervisorPath) {
    throw new Error(
      'Firecracker preview requires explicit kernel, rootfs, and guest supervisor artifacts',
    );
  }
  const digests = firecracker.sha256;
  if (
    !digests?.firecracker ||
    !digests.jailer ||
    !digests.kernel ||
    !digests.rootfs ||
    !digests.supervisor
  ) {
    throw new Error(
      'Firecracker preview requires SHA-256 digests for firecracker, jailer, kernel, rootfs, and supervisor',
    );
  }
}

export function assertFirecrackerPreSecurityCompatibility(config: WrapperConfig): void {
  if (config.networkIsolation === false) {
    throw new Error('Firecracker preview cannot disable --network-isolation');
  }
  if (
    config.enableDind ||
    config.dockerHostPathPrefix ||
    config.runnerTopology === 'arc-dind'
  ) {
    throw new Error('Firecracker preview does not support Docker-in-Docker or split filesystems');
  }
  if (config.enableHostAccess || config.allowHostPorts || config.allowHostServicePorts) {
    throw new Error('Firecracker preview does not support host access');
  }
  if (config.volumeMounts?.length) {
    throw new Error('Firecracker preview does not support additional host volume mounts');
  }
  if (
    config.topologyAttach?.length ||
    config.difcProxyHost ||
    config.enclaves?.enabled
  ) {
    throw new Error(
      'Firecracker preview does not yet prove the MCP gateway path; topology peers and enclaves are disabled',
    );
  }
  if (config.dnsOverHttps) {
    throw new Error('Firecracker preview does not support DNS-over-HTTPS');
  }
  if (config.tty) {
    throw new Error('Firecracker preview guest supervisor does not support --tty');
  }
  const dockerHost = config.awfDockerHost ?? getLocalDockerEnv().DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    throw new Error(
      'Firecracker preview requires a local Unix-socket Docker daemon so its bridge is host-visible',
    );
  }
}

export function requireFirecrackerConfig(config: WrapperConfig): FirecrackerOptions {
  if (config.containerRuntime !== 'firecracker' || !config.firecracker) {
    throw new Error('Firecracker backend resolved without Firecracker runtime configuration');
  }
  return config.firecracker;
}
