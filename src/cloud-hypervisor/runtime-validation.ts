import { getLocalDockerEnv } from '../docker-host';
import type { CloudHypervisorOptions, WrapperConfig } from '../types';
import { CLOUD_HYPERVISOR_MOUNT_POLICIES } from '../types/runtime-options';
import { assertGithubHostedRunnerEligibility } from './host-eligibility';

/**
 * Explicit, fail-closed compatibility guards for the Cloud Hypervisor
 * v53.0 microVM runtime. This module enforces security-mode
 * and Docker-host requirements, with two Cloud
 * Hypervisor-specific additions: no jailer digest is required (Cloud
 * Hypervisor has no jailer-equivalent process) and host eligibility is
 * additionally restricted to GitHub-hosted Ubuntu x86_64 KVM runners via
 * {@link assertGithubHostedRunnerEligibility}; self-hosted runners are not
 * supported.
 */

export function isPrimaryCloudHypervisorRuntime(
  config: Pick<WrapperConfig, 'containerRuntime'>,
): boolean {
  return config.containerRuntime === 'cloud-hypervisor';
}

export function usesCloudHypervisorEnclaveRuntime(
  config: Pick<WrapperConfig, 'enclaves'>,
): boolean {
  const executors = config.enclaves?.executors;
  return Boolean(
    (executors?.script.enabled && executors.script.runtime === 'cloud-hypervisor')
    || (executors?.agent.enabled && executors.agent.runtime === 'cloud-hypervisor'),
  );
}

export function requiresCloudHypervisorInfrastructure(
  config: Pick<WrapperConfig, 'containerRuntime' | 'enclaves'>,
): boolean {
  return isPrimaryCloudHypervisorRuntime(config) || usesCloudHypervisorEnclaveRuntime(config);
}

function usesCloudHypervisorAgentRuntime(config: Pick<WrapperConfig, 'enclaves'>): boolean {
  const agent = config.enclaves?.executors.agent;
  return Boolean(agent?.enabled && agent.runtime === 'cloud-hypervisor');
}

export function assertCloudHypervisorSelection(config: WrapperConfig): void {
  const required = requiresCloudHypervisorInfrastructure(config);
  if (config.cloudHypervisor && !required) {
    throw new Error(
      'Cloud Hypervisor options require either --container-runtime cloud-hypervisor '
      + 'or an enclaves[].runtime of "cloud-hypervisor"',
    );
  }
  if (required && !config.cloudHypervisor) {
    throw new Error(
      'Cloud Hypervisor workload selection requires top-level cloudHypervisor runtime configuration',
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
  if (!CLOUD_HYPERVISOR_MOUNT_POLICIES.includes(cloudHypervisor.mountPolicy)) {
    throw new Error(
      'Cloud Hypervisor mount policy must be "workspace-only" or "workspace-and-tool-cache"',
    );
  }
  if (!config.networkIsolation || config.legacySecurity) {
    throw new Error('Cloud Hypervisor preview requires strict --network-isolation security');
  }
  if (
    (isPrimaryCloudHypervisorRuntime(config) || usesCloudHypervisorAgentRuntime(config))
    && !config.enableApiProxy
  ) {
    throw new Error('Cloud Hypervisor preview requires API proxy credential isolation');
  }
  assertCloudHypervisorPreSecurityCompatibility(config);
  if (!cloudHypervisor.kernelPath || !cloudHypervisor.rootfsPath || !cloudHypervisor.supervisorPath) {
    throw new Error(
      'Cloud Hypervisor preview requires explicit kernel, rootfs, and guest supervisor artifacts',
    );
  }
  if (cloudHypervisor.developmentAllowUnattestedArtifacts) {
    if (
      process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS !== '1'
    ) {
      throw new Error(
        'Cloud Hypervisor development artifact bypass requires ' +
        'AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1',
      );
    }
    const digests = cloudHypervisor.sha256;
    if (
      !digests?.cloudHypervisor ||
      !digests.virtiofsd ||
      !digests.kernel ||
      !digests.rootfs ||
      !digests.supervisor
    ) {
      throw new Error(
        'Cloud Hypervisor development artifact bypass requires SHA-256 digests for all five artifacts',
      );
    }
  } else if (
    !cloudHypervisor.artifactManifestPath ||
    !cloudHypervisor.artifactManifestBundlePath ||
    !cloudHypervisor.artifactReleaseTag
  ) {
    throw new Error(
      'Cloud Hypervisor preview requires an artifact manifest, attestation bundle, and expected release tag',
    );
  } else if (cloudHypervisor.sha256) {
    throw new Error(
      'Caller-supplied Cloud Hypervisor SHA-256 values are accepted only by the explicit development artifact bypass',
    );
  }
  assertGithubHostedRunnerEligibility();
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
  const primaryCloudHypervisor = isPrimaryCloudHypervisorRuntime(config);
  if (primaryCloudHypervisor && config.volumeMounts?.length) {
    throw new Error('Cloud Hypervisor preview does not support additional host volume mounts');
  }
  if (config.difcProxyHost) {
    throw new Error('Cloud Hypervisor preview does not yet support DIFC proxies');
  }
  if (primaryCloudHypervisor && config.enclaves?.enabled) {
    throw new Error(
      'Cloud Hypervisor primary-agent execution with enclaves is reserved until the '
      + 'runtime-neutral enclave lifecycle integration lands; no runtime fallback is permitted',
    );
  }
  if (primaryCloudHypervisor && config.dnsOverHttps) {
    throw new Error('Cloud Hypervisor preview does not support DNS-over-HTTPS');
  }
  if (primaryCloudHypervisor && config.tty) {
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
  if (!requiresCloudHypervisorInfrastructure(config) || !config.cloudHypervisor) {
    throw new Error('Cloud Hypervisor backend resolved without Cloud Hypervisor runtime configuration');
  }
  return config.cloudHypervisor;
}
