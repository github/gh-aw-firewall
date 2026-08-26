/**
 * Apple Container host facts and fail-closed eligibility evaluation.
 *
 * Apple `container` is a VM-per-container OCI runtime that requires
 * Virtualization.framework. AWF supports it only on **self-hosted bare-metal
 * Apple Silicon** Actions runners: GitHub-hosted `macos-26` images are
 * themselves virtual machines and do not expose nested virtualization, so
 * `kern.hv_support` reports 0 there and no amount of retrying will help.
 *
 * This module is deliberately split from `./preflight.ts`. Host *identity*
 * (platform, architecture, macOS version, hypervisor support) is answered from
 * cheap, side-effect-free probes and can be evaluated before the `container`
 * CLI is known to exist. Live service checks (CLI presence, version, daemon
 * health) need the CLI adapter and live in preflight. Keeping them apart means
 * "we are on the wrong kind of machine" and "the runtime is not ready on this
 * machine" stay independently testable and produce distinguishable errors.
 *
 * Every probe is injected so the whole surface is unit-testable without a Mac.
 */

import execa from 'execa';

/** Minimum macOS major version; apple/container supports macOS 26 and newer. */
export const APPLE_CONTAINER_MINIMUM_MACOS_MAJOR = 26;

/** `sysctl` key reporting whether Virtualization.framework can start a VM. */
export const APPLE_CONTAINER_HV_SUPPORT_SYSCTL = 'kern.hv_support';

/**
 * Why a host cannot run the Apple Container runtime.
 *
 * Callers switch on this rather than matching message text, so a later layer
 * can decide per-cause whether to hard-fail or fall back to Docker.
 */
export type AppleContainerIneligibilityCode =
  | 'platform'
  | 'architecture'
  | 'macos-version'
  | 'hypervisor';

/** Immutable, already-probed description of the host. */
export interface AppleContainerHostFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** `sw_vers -productVersion` output, e.g. `"26.1.1"`. */
  readonly macosProductVersion: string;
  /** True only when `sysctl -n kern.hv_support` reported exactly `1`. */
  readonly hypervisorSupported: boolean;
}

export interface AppleContainerHostProbe {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Returns raw `sw_vers -productVersion` stdout. */
  readProductVersion(): Promise<string>;
  /** Returns raw `sysctl -n kern.hv_support` stdout. */
  readHypervisorSupport(): Promise<string>;
}

export type AppleContainerEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly code: AppleContainerIneligibilityCode;
      readonly reason: string;
    };

/** Thrown by {@link assertAppleContainerHostEligibility}; carries the cause code. */
export class AppleContainerHostError extends Error {
  constructor(
    readonly code: AppleContainerIneligibilityCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppleContainerHostError';
  }
}

async function readTrimmedStdout(binary: string, args: readonly string[]): Promise<string> {
  const result = await execa(binary, [...args], {
    reject: false,
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `"${binary} ${args.join(' ')}" exited with code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

const defaultProbe: AppleContainerHostProbe = {
  platform: process.platform,
  arch: process.arch,
  readProductVersion: () => readTrimmedStdout('/usr/bin/sw_vers', ['-productVersion']),
  readHypervisorSupport: () => readTrimmedStdout('/usr/sbin/sysctl', ['-n', APPLE_CONTAINER_HV_SUPPORT_SYSCTL]),
};

/** @internal Exposed so host-probe tests can assert the real command shapes. */
export const appleContainerHostProbeTestHelpers = { defaultProbe, readTrimmedStdout };

/**
 * Parses the major version from `sw_vers -productVersion` output.
 *
 * Throws rather than returning a sentinel: an unparseable version must not be
 * silently treated as "new enough".
 */
export function parseMacosMajorVersion(productVersion: string): number {
  // Parsed by splitting rather than with a nested-quantifier regex, which both
  // avoids a ReDoS-shaped pattern and makes the "all components must be
  // numeric" rule explicit.
  const components = productVersion.trim().split('.');
  const allNumeric = components.every((component) => /^\d+$/.test(component));
  if (!allNumeric || components.length === 0 || components[0].length === 0) {
    throw new Error(
      `Could not parse macOS product version from: ${JSON.stringify(productVersion)}`,
    );
  }
  return Number(components[0]);
}

/**
 * Interprets `sysctl -n kern.hv_support`.
 *
 * Only a literal `1` counts as supported; anything else (including `0`, empty
 * output, or unexpected text) is treated as unsupported.
 */
export function parseHypervisorSupport(sysctlOutput: string): boolean {
  return sysctlOutput.trim() === '1';
}

/**
 * Collects host facts. Probe failures are surfaced as
 * {@link AppleContainerHostError}s with the code they belong to, so a missing
 * `sw_vers` is reported as a macOS-version problem rather than an opaque
 * spawn error.
 */
export async function collectAppleContainerHostFacts(
  overrides: Partial<AppleContainerHostProbe> = {},
): Promise<AppleContainerHostFacts> {
  const probe: AppleContainerHostProbe = { ...defaultProbe, ...overrides };

  // Short-circuit before spawning Darwin-only tools; on Linux CI `sw_vers`
  // does not exist and its spawn error would be a misleading diagnosis.
  if (probe.platform !== 'darwin') {
    return {
      platform: probe.platform,
      arch: probe.arch,
      macosProductVersion: '',
      hypervisorSupported: false,
    };
  }

  if (probe.arch !== 'arm64') {
    return {
      platform: probe.platform,
      arch: probe.arch,
      macosProductVersion: '',
      hypervisorSupported: false,
    };
  }

  let macosProductVersion: string;
  try {
    macosProductVersion = (await probe.readProductVersion()).trim();
  } catch (error) {
    throw new AppleContainerHostError(
      'macos-version',
      `Could not determine the macOS version: ${formatCause(error)}`,
    );
  }

  let macosMajor: number;
  try {
    macosMajor = parseMacosMajorVersion(macosProductVersion);
  } catch {
    return {
      platform: probe.platform,
      arch: probe.arch,
      macosProductVersion,
      hypervisorSupported: false,
    };
  }
  if (macosMajor < APPLE_CONTAINER_MINIMUM_MACOS_MAJOR) {
    return {
      platform: probe.platform,
      arch: probe.arch,
      macosProductVersion,
      hypervisorSupported: false,
    };
  }

  let hypervisorSupported: boolean;
  try {
    hypervisorSupported = parseHypervisorSupport(await probe.readHypervisorSupport());
  } catch (error) {
    throw new AppleContainerHostError(
      'hypervisor',
      `Could not determine Virtualization.framework support via ` +
      `${APPLE_CONTAINER_HV_SUPPORT_SYSCTL}: ${formatCause(error)}`,
    );
  }

  return {
    platform: probe.platform,
    arch: probe.arch,
    macosProductVersion,
    hypervisorSupported,
  };
}

/**
 * Pure eligibility decision over already-collected facts.
 *
 * Checks run most-general first so the reported cause is the most actionable
 * one: a Linux host is told it is the wrong platform rather than being told its
 * hypervisor is missing.
 */
export function evaluateAppleContainerHostEligibility(
  facts: AppleContainerHostFacts,
): AppleContainerEligibility {
  if (facts.platform !== 'darwin') {
    return {
      eligible: false,
      code: 'platform',
      reason: `Apple Container requires macOS; found platform ${facts.platform}`,
    };
  }
  if (facts.arch !== 'arm64') {
    return {
      eligible: false,
      code: 'architecture',
      reason:
        'Apple Container requires Apple Silicon (arm64); found Node architecture ' +
        `${facts.arch}. Intel Macs and Rosetta-translated processes are not supported.`,
    };
  }

  let major: number;
  try {
    major = parseMacosMajorVersion(facts.macosProductVersion);
  } catch (error) {
    return {
      eligible: false,
      code: 'macos-version',
      reason: `Apple Container requires macOS ${APPLE_CONTAINER_MINIMUM_MACOS_MAJOR}+: ${formatCause(error)}`,
    };
  }
  if (major < APPLE_CONTAINER_MINIMUM_MACOS_MAJOR) {
    return {
      eligible: false,
      code: 'macos-version',
      reason:
        `Apple Container requires macOS ${APPLE_CONTAINER_MINIMUM_MACOS_MAJOR} or newer; ` +
        `found ${facts.macosProductVersion}`,
    };
  }

  if (!facts.hypervisorSupported) {
    return {
      eligible: false,
      code: 'hypervisor',
      reason:
        `Apple Container requires Virtualization.framework support ` +
        `(${APPLE_CONTAINER_HV_SUPPORT_SYSCTL} = 1). This is expected on GitHub-hosted macOS ` +
        'runners, which are themselves virtual machines without nested virtualization; use a ' +
        'self-hosted bare-metal Apple Silicon runner.',
    };
  }

  return { eligible: true };
}

/** Throws an {@link AppleContainerHostError} when the host is not eligible. */
export function assertAppleContainerHostEligibility(facts: AppleContainerHostFacts): void {
  const result = evaluateAppleContainerHostEligibility(facts);
  if (!result.eligible) {
    throw new AppleContainerHostError(result.code, result.reason);
  }
}

function formatCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
