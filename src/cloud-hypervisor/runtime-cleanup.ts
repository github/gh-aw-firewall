import type { GuestExecutionRequest, GuestExecutionResult } from '../microvm/vsock-client';
import type { WrapperConfig } from '../types';
import type { CloudHypervisorPreflightResult } from './preflight';
import {
  CLOUD_HYPERVISOR_GUEST_WORKSPACE,
  CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS,
  createBoundedOutputCollector,
  formatError,
} from './backend-utils';

const CLOUD_HYPERVISOR_CANCEL_GRACE_MS = 3_000;

interface RuntimeCleanupManager {
  readonly paths: { readonly runDirectory: string };
  readonly networkNamespace?: string;
  execute(request: GuestExecutionRequest): Promise<GuestExecutionResult>;
  cancel(reason?: string, requestId?: string): Promise<void>;
  stop(options?: { preserve?: boolean; beforeCleanup?: () => Promise<void> }): Promise<void>;
  collectDiagnostics(directory: string): Promise<void>;
  completeCleanupRecord(): Promise<void>;
}

interface RuntimeCleanupLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface StopManagerOptions {
  activeExecution: { requestId: string; promise: Promise<GuestExecutionResult> } | undefined;
  manager: RuntimeCleanupManager | undefined;
  preserve: boolean;
  cleanedManagers: Set<RuntimeCleanupManager>;
  cleanupArtifactSnapshot(): Promise<void>;
}

export async function stopManager({
  activeExecution,
  manager,
  preserve,
  cleanedManagers,
  cleanupArtifactSnapshot,
}: StopManagerOptions): Promise<void> {
  if (activeExecution && manager) {
    try {
      await manager.cancel('AWF cleanup', activeExecution.requestId);
    } catch {
      // Process termination below remains authoritative.
    }
    await Promise.race([
      activeExecution.promise.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, CLOUD_HYPERVISOR_CANCEL_GRACE_MS)),
    ]);
  }
  if (manager) {
    await manager.stop({ preserve });
    if (!preserve) cleanedManagers.add(manager);
  }
  if (!preserve) await cleanupArtifactSnapshot();
}

export interface CleanupArtifactSnapshotOptions {
  preflightResult: CloudHypervisorPreflightResult | undefined;
  manager: RuntimeCleanupManager | undefined;
  cleanedManagers: Set<RuntimeCleanupManager>;
  removeArtifactSnapshot(directory: string): Promise<void>;
}

export async function cleanupArtifactSnapshot({
  preflightResult,
  manager,
  cleanedManagers,
  removeArtifactSnapshot,
}: CleanupArtifactSnapshotOptions): Promise<boolean> {
  const directory = preflightResult?.artifactSnapshotDirectory;
  if (!directory) return false;
  await removeArtifactSnapshot(directory);
  if (manager) cleanedManagers.add(manager);
  for (const cleanedManager of cleanedManagers) {
    await cleanedManager.completeCleanupRecord();
  }
  cleanedManagers.clear();
  return true;
}

export interface CleanupFailedBootAttemptOptions {
  manager: RuntimeCleanupManager | undefined;
  bootAttempt: number;
  startupError: unknown;
  finalAttempt: boolean;
  diagnosticsDirectory: string;
  failedBootDiagnostics: string[];
  logger: RuntimeCleanupLogger;
}

export interface CleanupFailedBootAttemptResult {
  readonly managerCleared: boolean;
  readonly environmentCleared: boolean;
  readonly diagnosticsCollected: boolean;
}

export async function cleanupFailedBootAttempt({
  manager,
  bootAttempt,
  startupError,
  finalAttempt,
  diagnosticsDirectory,
  failedBootDiagnostics,
  logger,
}: CleanupFailedBootAttemptOptions): Promise<CleanupFailedBootAttemptResult> {
  if (!manager) {
    return {
      managerCleared: false,
      environmentCleared: false,
      diagnosticsCollected: false,
    };
  }
  let collectedFinalAttemptDiagnostics = false;
  const collectPreCleanupDiagnostics = async (): Promise<void> => {
    try {
      await manager.collectDiagnostics(diagnosticsDirectory);
      failedBootDiagnostics.push(diagnosticsDirectory);
      if (finalAttempt) collectedFinalAttemptDiagnostics = true;
    } catch (diagnosticsError) {
      logger.warn(
        `[cloud-hypervisor] failed to collect boot-attempt diagnostics ` +
        `attempt=${bootAttempt}: ${formatError(diagnosticsError)}`,
      );
    }
  };
  try {
    await manager.stop({ beforeCleanup: collectPreCleanupDiagnostics });
    return {
      managerCleared: true,
      environmentCleared: true,
      diagnosticsCollected: collectedFinalAttemptDiagnostics,
    };
  } catch (cleanupError) {
    const combined = new Error(
      `Cloud Hypervisor startup failed: ${formatError(startupError)}; ` +
      `microVM cleanup also failed: ${formatError(cleanupError)}`,
    );
    Object.defineProperty(combined, 'cause', { value: startupError });
    Object.assign(combined, { cleanupCause: cleanupError });
    throw combined;
  }
}

export interface CaptureGuestNetworkStateOptions {
  manager: RuntimeCleanupManager | undefined;
  environment: Record<string, string> | undefined;
  identity: { uid: number; gid: number } | undefined;
}

/**
 * Best-effort diagnostic-only helper: on a connectivity probe failure,
 * capture the guest's own view of its network configuration (interface
 * addresses and routing table) so a live-KVM failure log shows *why* the
 * guest couldn't reach Squid/API proxy (e.g. missing IP, missing
 * default route) rather than only a bare exit code. Never throws --
 * failures here are folded into an empty string rather than masking the
 * original probe failure.
 */
export async function captureGuestNetworkStateForDiagnostics({
  manager,
  environment,
  identity,
}: CaptureGuestNetworkStateOptions): Promise<string> {
  if (!manager || !environment || !identity) return '';
  try {
    const stdoutCollector = createBoundedOutputCollector();
    await manager.execute({
      requestId: `probe-netdiag-${process.pid}-${Date.now()}`,
      // `ip addr show` includes each interface's MAC (compared against
      // the plan's configured guest MAC and the nftables anti-spoof
      // rule during triage); note this deliberately omits `-d`
      // (detailed) since the guest's minimal BusyBox `ip` applet does
      // not reliably support it (unlike the real iproute2 used
      // host-side in network.ts's captureDiagnosticsInNamespace).
      // `ip neigh show` confirms the guest actually resolved the
      // gateway's MAC via ARP (a failure here would mean the guest
      // never got a reply to its own ARP request, independent of
      // anything TCP/Squid-related).
      argv: ['/bin/sh', '-c', 'ip addr show; echo ---; ip route show; echo ---; ip neigh show'],
      env: environment,
      cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
      ...identity,
      timeoutMs: CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS,
      stdout: stdoutCollector.stream,
    });
    return stdoutCollector.toString().trim();
  } catch {
    return '';
  }
}

export function getBootDiagnosticsDirectory(
  config: Pick<WrapperConfig, 'auditDir' | 'workDir'>,
  bootAttempt: number,
): string {
  return `${getDiagnosticsRoot(config)}/boot-attempt-${bootAttempt}`;
}

export function getDiagnosticsRoot(config: Pick<WrapperConfig, 'auditDir' | 'workDir'>): string {
  return config.auditDir
    ? `${config.auditDir}/cloud-hypervisor`
    : `${config.workDir}/diagnostics/cloud-hypervisor`;
}
