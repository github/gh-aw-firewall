import * as path from 'path';
import type { NvxOptions, WrapperConfig } from '../types';
import { NVX_MOUNT_POLICIES, type NvxMountPolicy } from '../types/runtime-options';
import { NVX_GUEST_WORKSPACE } from './workspace-export';

/**
 * Explicit, fail-closed compatibility guards for the NVX preview one-shot
 * microVM runtime.
 *
 * Unlike Cloud Hypervisor, NVX never falls back to another runtime when an
 * explicit selection is unsupported or misconfigured — every failure here
 * must be surfaced to the caller and abort the run. This divergence is a
 * deliberate, documented design decision rather than an unclosed parity gap:
 * see "Fallback behaviour" in docs/nvx-security-design.md.
 */

export function isPrimaryNvxRuntime(
  config: Pick<WrapperConfig, 'containerRuntime'>,
): boolean {
  return config.containerRuntime === 'nvx';
}

export function assertNvxSelection(config: WrapperConfig): void {
  const required = isPrimaryNvxRuntime(config);
  if (config.nvx && !required) {
    throw new Error(
      'NVX options require --container-runtime nvx',
    );
  }
  if (required && !config.nvx) {
    throw new Error(
      'NVX workload selection requires top-level nvx runtime configuration',
    );
  }
}

/**
 * Fail-closed compatibility checks that require the fully-assembled config
 * but not yet the (expensive) host/artifact preflight performed by
 * {@link runNvxPreflight}.
 */
export function assertNvxRuntimeCompatibility(
  config: WrapperConfig,
  nvx = requireNvxConfig(config),
): void {
  if (!nvx.previewEnabled) {
    throw new Error(
      'NVX workload execution requires explicit --nvx-preview opt-in',
    );
  }
  if (!config.networkIsolation || config.legacySecurity) {
    throw new Error('NVX preview requires strict --network-isolation security');
  }
  if (!config.enableApiProxy) {
    throw new Error('NVX preview requires API proxy credential isolation');
  }
  if (!NVX_MOUNT_POLICIES.includes(nvx.mountPolicy as NvxMountPolicy)) {
    throw new Error(
      'NVX mount policy must be "workspace-only" or "workspace-and-tool-cache"',
    );
  }
  // Deliberately still rejected at parity with the assessment recorded in
  // docs/nvx-security-design.md: the runtime-neutral microVM infrastructure
  // discovery in `src/microvm/infrastructure.ts` asserts the Docker network
  // carries exactly the compile-time default subnet, so an alternate subnet
  // cannot be honoured by NVX (or by Cloud Hypervisor) without changing that
  // shared contract. Rejecting is preferable to silently ignoring the flag.
  if (config.networkSubnet) {
    throw new Error(
      'NVX preview does not support --network-subnet; its microVM infrastructure '
      + 'discovery requires the fixed default awf-net subnet',
    );
  }
  if (config.tty) {
    throw new Error('NVX preview does not support --tty');
  }
  if (
    config.enableDind ||
    config.dockerHostPathPrefix ||
    config.runnerTopology === 'arc-dind'
  ) {
    throw new Error('NVX preview does not support Docker-in-Docker or split filesystems');
  }
  if (config.enableHostAccess || config.allowHostPorts || config.allowHostServicePorts) {
    throw new Error('NVX preview does not support host access');
  }
  if (config.volumeMounts?.length) {
    throw new Error('NVX preview does not support additional host volume mounts');
  }
  assertNvxContainerWorkDir(config.containerWorkDir);
  if (config.difcProxyHost) {
    throw new Error('NVX preview does not yet support DIFC proxies');
  }
  if (config.dnsOverHttps) {
    throw new Error('NVX preview does not support DNS-over-HTTPS');
  }
  if (config.enclaves?.enabled) {
    throw new Error(
      'NVX primary-agent execution with enclaves is reserved until the '
      + 'runtime-neutral enclave lifecycle integration lands; no runtime fallback is permitted',
    );
  }
  if (!nvx.layerPath) {
    throw new Error('NVX preview requires an explicit guest distro layer (--nvx-layer)');
  }
  if (!nvx.openvmmPath || !nvx.kernelPath || !nvx.initramfsPath) {
    throw new Error(
      'NVX preview requires explicit OpenVMM, kernel, and initramfs artifact paths',
    );
  }
  if (!nvx.artifactManifestPath || !nvx.artifactManifestBundlePath) {
    throw new Error(
      'NVX preview requires an artifact manifest and attestation bundle',
    );
  }
  assertNvxHostEligibility();
}

/**
 * `--container-workdir` selects the guest directory the agent command runs in.
 * The host workspace is exported live at {@link NVX_GUEST_WORKSPACE}, so any
 * directory inside that export is addressable; paths outside it would resolve
 * against the read-only guest distro layer and are rejected rather than
 * silently ignored.
 */
export function assertNvxContainerWorkDir(containerWorkDir?: string): void {
  if (!containerWorkDir) return;
  if (!path.posix.isAbsolute(containerWorkDir)) {
    throw new Error(
      `NVX preview requires an absolute --container-workdir; found ${containerWorkDir}`,
    );
  }
  const normalized = path.posix.normalize(containerWorkDir).replace(/\/+$/, '')
    || NVX_GUEST_WORKSPACE;
  if (
    normalized !== NVX_GUEST_WORKSPACE &&
    !normalized.startsWith(`${NVX_GUEST_WORKSPACE}/`)
  ) {
    throw new Error(
      `NVX preview --container-workdir must be inside the guest workspace export `
      + `${NVX_GUEST_WORKSPACE}; found ${containerWorkDir}`,
    );
  }
}

/**
 * Resolves the guest working directory for a run, defaulting to the workspace
 * export root.
 */
export function resolveNvxGuestWorkDir(containerWorkDir?: string): string {
  assertNvxContainerWorkDir(containerWorkDir);
  if (!containerWorkDir) return NVX_GUEST_WORKSPACE;
  return path.posix.normalize(containerWorkDir).replace(/\/+$/, '') || NVX_GUEST_WORKSPACE;
}

/**
 * Necessary-but-not-sufficient host eligibility check: NVX supports only
 * Linux x86_64 KVM hosts. This mirrors the platform/architecture guard in
 * `runNvxPreflight` (`src/nvx/preflight.ts`) so callers get an actionable
 * error before the heavier artifact/tool preflight runs.
 */
export function assertNvxHostEligibility(
  env: { platform: NodeJS.Platform; arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): void {
  if (env.platform !== 'linux') {
    throw new Error(`NVX requires a Linux host; found ${env.platform}`);
  }
  if (env.arch !== 'x64') {
    throw new Error(`NVX supports only x86_64 hosts; found Node architecture ${env.arch}`);
  }
}

export function requireNvxConfig(config: WrapperConfig): NvxOptions {
  if (!isPrimaryNvxRuntime(config) || !config.nvx) {
    throw new Error('NVX backend resolved without NVX runtime configuration');
  }
  return config.nvx;
}
