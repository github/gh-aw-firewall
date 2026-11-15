import execa from 'execa';
import { CLOUD_HYPERVISOR_RELEASE_VERSION } from '../types/runtime-options';
import { logger } from '../logger';
import { buildExecutionFailureDiagnostics } from './preflight-diagnostics';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';
import type { CloudHypervisorCommonArtifactSnapshot } from './artifact-snapshot';
import type { CloudHypervisorPreflightDependencies } from './preflight';

async function versionProbeExecutionError(
  binaryPath: string,
  details: string,
  code?: string,
): Promise<Error> {
  let message: string;
  if (code === 'ENOENT') {
    message =
      `Required external binary "${binaryPath}" is unavailable: the binary or its interpreter ` +
      `was not found${details ? ` (${details})` : ''}`;
  } else if (code === 'EACCES') {
    message =
      `Permission denied executing "${binaryPath} --version"; verify path traversal permissions ` +
      `and that the artifact is on an exec-capable mount${details ? `: ${details}` : ''}`;
    message += await buildExecutionFailureDiagnostics(binaryPath);
  } else {
    message =
      `Unable to execute required external binary "${binaryPath} --version"; verify the trusted ` +
      `artifact exists, is executable, and is complete${details ? `: ${details}` : ''}`;
    message += await buildExecutionFailureDiagnostics(binaryPath);
  }
  return Object.assign(new Error(message), code ? { code } : {});
}

export async function runVersion(binaryPath: string): Promise<string> {
  let result;
  try {
    result = await execa(binaryPath, ['--version'], {
      reject: false,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const code = error && typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
    const details = [
      code ? `code=${code}` : '',
      error instanceof Error ? error.message : String(error),
    ].filter(Boolean).join('; ');
    throw await versionProbeExecutionError(
      binaryPath,
      details,
      code,
    );
  }
  if (result.exitCode == null && !result.signal) {
    const executionError = result as typeof result & {
      code?: unknown;
      shortMessage?: unknown;
    };
    const codeValue = typeof executionError.code === 'string' ? executionError.code : undefined;
    const code = codeValue ? `code=${codeValue}` : '';
    const shortMessage = typeof executionError.shortMessage === 'string'
      ? executionError.shortMessage
      : '';
    const details = [code, shortMessage, result.stderr.trim()].filter(Boolean).join('; ');
    throw await versionProbeExecutionError(binaryPath, details, codeValue);
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const signalCode = result.signal ?? null;
    const exitCode = result.exitCode ?? null;
    const termination = signalCode
      ? `terminated by signal ${signalCode}`
      : `exited with code ${exitCode}`;
    throw markHostPreflightError(new Error(
      `"${binaryPath} --version" ${termination} ` +
      `(exitCode=${exitCode}, signalCode=${signalCode})${stderr ? `: ${stderr}` : ''}`,
    ), 'command-failed');
  }
  return `${result.stdout}\n${result.stderr}`.trim();
}

/**
 * Number of attempts for the post-digest-verification `--version` probe.
 * The staged artifact's content is already digest-verified before this runs,
 * so a probe failure here reflects a transient host/exec hiccup (e.g. a
 * momentary I/O error copying/executing the just-staged binary) rather than
 * a corrupt or wrong artifact. Retrying a couple of times avoids failing an
 * entire run over a fleeting condition. See gh-aw-firewall#8767.
 */
const CLOUD_HYPERVISOR_VERSION_PROBE_ATTEMPTS = 3;
const CLOUD_HYPERVISOR_VERSION_PROBE_RETRY_DELAY_MS = 250;

/**
 * Error codes indicating a deterministic, non-transient version-probe
 * failure: the binary is missing, not a regular file, or not executable.
 * These will not resolve on retry, so they are allowed to fail closed
 * immediately instead of paying the retry delay. The default `runVersion`
 * attaches a structured `code` property when the underlying spawn failure
 * carries one (see its `Object.assign(new Error(...), { code })` above);
 * the `code=XXX` message fragment is used as a fallback for callers that
 * inject a custom `runVersion` throwing a plain `Error`.
 */
const CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'ENOEXEC',
]);
const CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODE_PATTERN = /\bcode=(ENOENT|EACCES|EISDIR|ENOTDIR|ENOEXEC)\b/;

function isPermanentVersionProbeError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return CLOUD_HYPERVISOR_VERSION_PROBE_PERMANENT_ERROR_CODE_PATTERN.test(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `dependencies.runVersion` with a small bounded retry for transient
 * execution failures. The binary's digest has already been verified to
 * match the trusted manifest by the time this is called, so any rejection
 * here is an execution-environment problem, not an artifact integrity
 * problem, and is generally safe to retry. Deterministic failures (missing
 * file, permission denied, etc.) are not retried since they would not
 * resolve on their own.
 */
export async function runVersionWithRetry(
  dependencies: Pick<CloudHypervisorPreflightDependencies, 'runVersion'>,
  binaryPath: string,
  attempts: number = CLOUD_HYPERVISOR_VERSION_PROBE_ATTEMPTS,
  retryDelayMs: number = CLOUD_HYPERVISOR_VERSION_PROBE_RETRY_DELAY_MS,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await dependencies.runVersion(binaryPath);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && !isPermanentVersionProbeError(error)) {
        logger.warn(
          `Cloud Hypervisor version probe failed for "${binaryPath}" ` +
          `(attempt ${attempt}/${attempts}); retrying: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(retryDelayMs);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

/**
 * Parses a `cloud-hypervisor --version` output like `cloud-hypervisor v53.0`
 * (also accepts the plain `v53.0`/`53.0` forms some builds emit).
 */
export function parseCloudHypervisorVersion(output: string): string {
  const match = output.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/);
  if (!match) {
    throw markHostPreflightError(new Error(`Could not parse Cloud Hypervisor version from: ${JSON.stringify(output)}`), 'version-format');
  }
  return match[1];
}

export const VIRTIOFSD_RELEASE_VERSION = '1.13.3';

export function parseVirtiofsdVersion(output: string): string {
  const match = output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/);
  if (!match) {
    throw markHostPreflightError(new Error(`Could not parse virtiofsd version from: ${JSON.stringify(output)}`), 'version-format');
  }
  return match[1];
}

export async function checkArtifactVersions(
  report: HostPreflightReporter,
  dependencies: Pick<CloudHypervisorPreflightDependencies, 'runVersion'>,
  config: CloudHypervisorCommonArtifactSnapshot,
): Promise<string> {
  const version = await report.check('cloud-hypervisor-version', async () => {
    const parsed = parseCloudHypervisorVersion(
      await runVersionWithRetry(dependencies, config.cloudHypervisorBinary),
    );
    if (parsed !== CLOUD_HYPERVISOR_RELEASE_VERSION) {
      throw markHostPreflightError(new Error(
        `Cloud Hypervisor is pinned to v${CLOUD_HYPERVISOR_RELEASE_VERSION}; found v${parsed}`,
      ), 'version-mismatch');
    }
    return parsed;
  });
  await report.check('virtiofsd-version', async () => {
    const virtiofsdVersion = parseVirtiofsdVersion(
      await runVersionWithRetry(dependencies, config.virtiofsdBinary),
    );
    if (virtiofsdVersion !== VIRTIOFSD_RELEASE_VERSION) {
      throw markHostPreflightError(new Error(
        `virtiofsd is pinned to v${VIRTIOFSD_RELEASE_VERSION}; found v${virtiofsdVersion}`,
      ), 'version-mismatch');
    }
  });
  return version;
}
