import { getLocalDockerEnv } from '../docker-host';
import type { CloudHypervisorOptions, WrapperConfig } from '../types';
import { assertGithubHostedRunnerEligibility } from './host-eligibility';

/**
 * Explicit, fail-closed compatibility guards for the Cloud Hypervisor
 * v53.0 microVM runtime. This module mirrors
 * `src/firecracker/runtime-validation.ts` closely — same security-mode,
 * topology, and Docker-host requirements — with two Cloud
 * Hypervisor-specific additions: no jailer digest is required (Cloud
 * Hypervisor has no jailer-equivalent process) and host eligibility is
 * additionally restricted to GitHub-hosted Ubuntu x86_64 KVM runners via
 * {@link assertGithubHostedRunnerEligibility} (self-hosted runners are not
 * supported, unlike Firecracker's preview).
 */

export function assertCloudHypervisorSelection(config: WrapperConfig): void {
  if (config.cloudHypervisor && config.containerRuntime !== 'cloud-hypervisor') {
    throw new Error(
      'Cloud Hypervisor options require --container-runtime cloud-hypervisor',
    );
  }
}

export function assertCloudHypervisorRuntimeCompatibility(
  config: WrapperConfig,
  cloudHypervisor = requireCloudHypervisorConfig(config),
): void {
  if (!cloudHypervisor.previewEnabled) {
    throw new Error(
      'Cloud Hypervisor workload execution requires explicit --cloud-hypervisor-preview opt-in',
    );
  }
  if (!config.networkIsolation || config.legacySecurity) {
    throw new Error('Cloud Hypervisor preview requires strict --network-isolation security');
  }
  if (!config.enableApiProxy) {
    throw new Error('Cloud Hypervisor preview requires API proxy credential isolation');
  }
  assertCloudHypervisorPreSecurityCompatibility(config);
  assertGithubHostedRunnerEligibility();
  if (!cloudHypervisor.kernelPath || !cloudHypervisor.rootfsPath || !cloudHypervisor.supervisorPath) {
    throw new Error(
      'Cloud Hypervisor preview requires explicit kernel, rootfs, and guest supervisor artifacts',
    );
  }
  const digests = cloudHypervisor.sha256;
  if (
    !digests?.cloudHypervisor ||
    !digests.kernel ||
    !digests.rootfs ||
    !digests.supervisor
  ) {
    throw new Error(
      'Cloud Hypervisor preview requires SHA-256 digests for cloud-hypervisor, kernel, rootfs, and supervisor',
    );
  }
}

export function assertCloudHypervisorPreSecurityCompatibility(config: WrapperConfig): void {
  if (config.networkIsolation === false) {
    throw new Error('Cloud Hypervisor preview cannot disable --network-isolation');
  }
  if (
    config.enableDind ||
    config.dockerHostPathPrefix ||
    config.runnerTopology === 'arc-dind'
  ) {
    throw new Error('Cloud Hypervisor preview does not support Docker-in-Docker or split filesystems');
  }
  if (config.enableHostAccess || config.allowHostPorts || config.allowHostServicePorts) {
    throw new Error('Cloud Hypervisor preview does not support host access');
  }
  if (config.volumeMounts?.length) {
    throw new Error('Cloud Hypervisor preview does not support additional host volume mounts');
  }
  if (
    config.topologyAttach?.length ||
    config.difcProxyHost ||
    config.enclaves?.enabled
  ) {
    throw new Error(
      'Cloud Hypervisor preview does not yet prove the MCP gateway path; topology peers and enclaves are disabled',
    );
  }
  if (config.dnsOverHttps) {
    throw new Error('Cloud Hypervisor preview does not support DNS-over-HTTPS');
  }
  if (config.tty) {
    throw new Error('Cloud Hypervisor preview guest supervisor does not support --tty');
  }
  const dockerHost = config.awfDockerHost ?? getLocalDockerEnv().DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    throw new Error(
      'Cloud Hypervisor preview requires a local Unix-socket Docker daemon so its bridge is host-visible',
    );
  }
}

export function requireCloudHypervisorConfig(config: WrapperConfig): CloudHypervisorOptions {
  if (config.containerRuntime !== 'cloud-hypervisor' || !config.cloudHypervisor) {
    throw new Error('Cloud Hypervisor backend resolved without Cloud Hypervisor runtime configuration');
  }
  return config.cloudHypervisor;
}
