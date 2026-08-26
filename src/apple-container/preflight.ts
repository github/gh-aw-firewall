/**
 * Fail-closed preflight for the Apple Container runtime.
 *
 * Composes the two halves of the supported-host contract:
 *
 * 1. Host identity — Darwin, arm64, macOS 26+, Virtualization.framework usable
 *    (`./host-facts.ts`).
 * 2. Runtime readiness — the `container` CLI is present, new enough, and its
 *    service reports healthy (`./lifecycle.ts`).
 *
 * Ordering is part of the contract: identity is checked first so an ineligible
 * machine is told *why it is the wrong machine* rather than being told the CLI
 * is missing, which would send an operator down the wrong path (in particular,
 * a GitHub-hosted macOS runner fails on `hypervisor`, not on `cli-missing`).
 *
 * Every failure raises {@link AppleContainerPreflightError} carrying a
 * machine-readable cause code, so a later layer can decide per-cause whether to
 * hard-fail or fall back. Nothing here retries, degrades, or returns a partial
 * "probably fine" result.
 */

import { AppleContainerCli, type AppleContainerCliOptions } from './cli';
import {
  assertAppleContainerHostEligibility,
  collectAppleContainerHostFacts,
  AppleContainerHostError,
  type AppleContainerHostFacts,
  type AppleContainerHostProbe,
  type AppleContainerIneligibilityCode,
} from './host-facts';
import { AppleContainerLifecycle, AppleContainerVersionParseError } from './lifecycle';

/**
 * Minimum supported `container` CLI version.
 *
 * Pinned to the first release line whose `--network` handling includes the
 * `none` sentinel that `./run-args.ts` depends on for a no-NIC container.
 * Lowering this would silently give an isolated container a default NIC.
 */
export const APPLE_CONTAINER_MINIMUM_CLI_VERSION = '0.4.0';

/** All the reasons preflight can fail, including host ineligibility. */
export type AppleContainerPreflightCode =
  | AppleContainerIneligibilityCode
  | 'cli-missing'
  | 'cli-version'
  | 'service-health';

export class AppleContainerPreflightError extends Error {
  constructor(
    readonly code: AppleContainerPreflightCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppleContainerPreflightError';
  }
}

export interface AppleContainerPreflightResult {
  readonly facts: AppleContainerHostFacts;
  readonly cliBinary: string;
  readonly cliVersion: string;
}

export interface AppleContainerPreflightDependencies {
  readonly hostProbe?: Partial<AppleContainerHostProbe>;
  readonly cli?: AppleContainerCli | AppleContainerCliOptions;
  readonly lifecycle?: Pick<AppleContainerLifecycle, 'version' | 'systemStatus' | 'cli'>;
  readonly minimumCliVersion?: string;
}

/**
 * Compares dotted numeric versions component-wise.
 *
 * Returns a negative number when `left` precedes `right`. Missing components
 * are treated as 0, so `0.4` and `0.4.0` compare equal.
 */
export function compareAppleContainerVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const parts = value.trim().replace(/^v/i, '').split('.');
    return parts.map((part) => {
      const parsed = Number(part);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`Apple Container version component is not a number: ${value}`);
      }
      return parsed;
    });
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Runs the full fail-closed preflight and returns the validated host contract.
 *
 * @throws {AppleContainerPreflightError} on any unmet requirement.
 */
export async function runAppleContainerPreflight(
  dependencies: AppleContainerPreflightDependencies = {},
): Promise<AppleContainerPreflightResult> {
  const facts = await collectHostFacts(dependencies);
  try {
    assertAppleContainerHostEligibility(facts);
  } catch (error) {
    if (error instanceof AppleContainerHostError) {
      throw new AppleContainerPreflightError(error.code, error.message);
    }
    throw error;
  }

  const lifecycle = dependencies.lifecycle
    ?? new AppleContainerLifecycle(
      dependencies.cli instanceof AppleContainerCli
        ? dependencies.cli
        : new AppleContainerCli(dependencies.cli ?? {}),
    );

  let cliVersion: string;
  try {
    cliVersion = (await lifecycle.version()).version;
  } catch (error) {
    // An installed CLI whose banner we cannot parse is a version problem, not a
    // missing install; conflating them would tell the operator to install a CLI
    // they already have.
    if (error instanceof AppleContainerVersionParseError) {
      throw new AppleContainerPreflightError('cli-version', error.message);
    }
    throw new AppleContainerPreflightError(
      'cli-missing',
      'The Apple Container CLI ("container") could not be run. Install it from ' +
      `https://github.com/apple/container and ensure it is on PATH: ${formatCause(error)}`,
    );
  }

  const minimum = dependencies.minimumCliVersion ?? APPLE_CONTAINER_MINIMUM_CLI_VERSION;
  let comparison: number;
  try {
    comparison = compareAppleContainerVersions(cliVersion, minimum);
  } catch (error) {
    throw new AppleContainerPreflightError('cli-version', formatCause(error));
  }
  if (comparison < 0) {
    throw new AppleContainerPreflightError(
      'cli-version',
      `Apple Container CLI ${minimum} or newer is required; found ${cliVersion}`,
    );
  }

  const status = await lifecycle.systemStatus();
  if (!status.healthy) {
    const detail = (status.result.stderr.trim() || status.result.stdout.trim()).slice(0, 500);
    throw new AppleContainerPreflightError(
      'service-health',
      'The Apple Container service is not running. Start it with "container system start"' +
      (detail ? `: ${detail}` : '.'),
    );
  }

  return { facts, cliBinary: lifecycle.cli.binary, cliVersion };
}

async function collectHostFacts(
  dependencies: AppleContainerPreflightDependencies,
): Promise<AppleContainerHostFacts> {
  try {
    return await collectAppleContainerHostFacts(dependencies.hostProbe ?? {});
  } catch (error) {
    if (error instanceof AppleContainerHostError) {
      throw new AppleContainerPreflightError(error.code, error.message);
    }
    throw error;
  }
}

function formatCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
