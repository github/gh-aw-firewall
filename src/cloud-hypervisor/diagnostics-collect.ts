import * as path from 'path';
import type { MicrovmNetworkLifecycle, MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorNetworkLifecycle } from './network-namespace';
import {
  CLOUD_HYPERVISOR_RELEASE_VERSION,
  type CloudHypervisorOptions,
} from '../types/runtime-options';
import type {
  CloudHypervisorApiClient,
  CloudHypervisorVmCounters,
  CloudHypervisorVmInfo,
} from './api-client';
import {
  CLOUD_HYPERVISOR_LOG_NAME,
  CLOUD_HYPERVISOR_SERIAL_LOG_NAME,
  formatError,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorRunPaths,
} from './manager-types';
import type { VirtiofsdDevice } from './virtiofsd';
import type { CloudHypervisorConfinementEvidence } from './confinement-verifier';
import type { GuestConnectionDiagnostics } from './guest-execution';
import { redactPublicEnclaveText } from '../enclave/public-debug-redaction';
import { copyBoundedDiagnostic, type BoundedOutputCapture } from './diagnostics-capture';
import {
  prepareAuditDirectory,
  prepareRootOwnedDebugDirectory,
  writeAuditFile,
} from './diagnostics-paths';

export interface CloudHypervisorDiagnosticsContext {
  dependencies: CloudHypervisorManagerDependencies;
  paths: CloudHypervisorRunPaths;
  config: CloudHypervisorOptions;
  stdoutCapture: BoundedOutputCapture;
  stderrCapture: BoundedOutputCapture;
  guestStdoutCapture: BoundedOutputCapture;
  guestStderrCapture: BoundedOutputCapture;
  captureGuestRawOutput?: boolean;
  network: MicrovmNetworkLifecycle | CloudHypervisorNetworkLifecycle | undefined;
  networkPlan: MicrovmNetworkPlan | undefined;
  client: CloudHypervisorApiClient | undefined;
  instanceStarted: boolean;
  guestConnection?: GuestConnectionDiagnostics;
  // Snapshotted by stop(), before any shutdown attempt, since the API
  // socket becomes unresponsive once the process is asked to exit.
  lastVmInfo: CloudHypervisorVmInfo | undefined;
  lastVmCounters: CloudHypervisorVmCounters | undefined;
  fsDevices: readonly VirtiofsdDevice[];
  confinementEvidence: CloudHypervisorConfinementEvidence | undefined;
  debugArtifactProtectedRoot?: string;
  debugSecrets?: readonly string[];
}

export async function collectCloudHypervisorDiagnostics(
  directory: string,
  context: CloudHypervisorDiagnosticsContext,
): Promise<void> {
  const { dependencies, paths, config } = context;
  const preparedAuditDirectory = context.debugArtifactProtectedRoot
    ? await prepareRootOwnedDebugDirectory(directory, context.debugArtifactProtectedRoot, dependencies)
    : await prepareAuditDirectory(directory, dependencies);
  const identity = preparedAuditDirectory.identity;
  directory = preparedAuditDirectory.directory;
  // Prefer the snapshot stop() takes *before* any shutdown attempt (see
  // the comment at the top of stop()): by the time collectDiagnostics()
  // runs via the beforeCleanup hook, the API socket is already
  // unresponsive (process already asked to exit), so a live call here
  // would just fail. Fall back to a live call only when this method is
  // invoked directly, outside of stop() (e.g. --diagnostic-logs without
  // a failure, or this method's own unit tests), where the client may
  // still be genuinely reachable.
  let counters: unknown = context.lastVmCounters ?? null;
  if (counters === null && context.client && context.instanceStarted) {
    try {
      counters = await context.client.vmCounters();
    } catch {
      counters = null;
    }
  }
  let vmInfo: unknown = context.lastVmInfo ?? null;
  if (vmInfo === null && context.client && context.instanceStarted) {
    try {
      vmInfo = await context.client.vmInfo();
    } catch {
      vmInfo = null;
    }
  }
  const writeBounded = async (fileName: string, contents: string | Buffer): Promise<void> => {
    const destination = path.join(directory, fileName);
    await writeAuditFile(dependencies, destination,
      context.debugArtifactProtectedRoot ? redactPublicEnclaveText(Buffer.from(contents), context.debugSecrets ?? []) : contents,
      identity);
  };
  const streamContents = (capture: BoundedOutputCapture) =>
    context.debugArtifactProtectedRoot ? capture.publicContents() : capture.contents();
  await writeBounded('launcher-stdout.log', streamContents(context.stdoutCapture));
  await writeBounded('launcher-stderr.log', streamContents(context.stderrCapture));
  if (context.captureGuestRawOutput !== false) {
    await writeBounded('guest-stdout.raw.log', streamContents(context.guestStdoutCapture));
    await writeBounded('guest-stderr.raw.log', streamContents(context.guestStderrCapture));
    if (context.debugArtifactProtectedRoot) {
      await writeBounded('stdout.log', streamContents(context.guestStdoutCapture));
      await writeBounded('stderr.log', streamContents(context.guestStderrCapture));
    }
  }
  await copyBoundedDiagnostic(
    dependencies,
    paths.logPath,
    path.join(directory, CLOUD_HYPERVISOR_LOG_NAME),
    identity,
    context.debugArtifactProtectedRoot ? context.debugSecrets ?? [] : undefined,
  );
  await copyBoundedDiagnostic(
    dependencies,
    paths.serialLogPath,
    path.join(directory, CLOUD_HYPERVISOR_SERIAL_LOG_NAME),
    identity,
    context.debugArtifactProtectedRoot ? context.debugSecrets ?? [] : undefined,
  );
  for (const [index, device] of context.fsDevices.entries()) {
    await copyBoundedDiagnostic(
      dependencies,
      device.logPath,
      path.join(directory, `virtiofs-${index}-${device.export.tag}.log`),
      identity,
      context.debugArtifactProtectedRoot ? context.debugSecrets ?? [] : undefined,
    );
    await copyBoundedDiagnostic(
      dependencies,
      device.evidencePath,
      path.join(directory, `virtiofs-${index}-${device.export.tag}-confinement.json`),
      identity,
      context.debugArtifactProtectedRoot ? context.debugSecrets ?? [] : undefined,
    );
  }
  await writeBounded(
    'network-plan.json',
    `${JSON.stringify(context.networkPlan ?? null, null, 2)}\n`,
  );
  // Best-effort, read-only host-side network diagnostics (live nftables
  // ruleset + interface counters), captured only while the namespace
  // still exists (this method runs via stop()'s beforeCleanup hook,
  // before network.cleanup() tears the namespace down). Helps diagnose
  // a guest connectivity failure (dropped by a forward-chain rule vs.
  // never reaching the tap at all) without guessing from the guest
  // side alone.
  let networkDiagnostics = '(network namespace not set up)';
  if (context.network?.captureDiagnostics) {
    try {
      networkDiagnostics = await context.network.captureDiagnostics();
    } catch (error) {
      networkDiagnostics = `(capture failed: ${formatError(error)})`;
    }
  }
  await writeBounded(
    'network-diagnostics.txt',
    `${networkDiagnostics}\n`,
  );
  await writeBounded(
    'counters.json',
    `${JSON.stringify(counters, null, 2)}\n`,
  );
  await writeBounded(
    'vm-info.json',
    `${JSON.stringify(vmInfo, null, 2)}\n`,
  );
  await writeBounded(
    'runtime.json',
    `${JSON.stringify({
      runtime: 'cloud-hypervisor',
      version: CLOUD_HYPERVISOR_RELEASE_VERSION,
      runId: paths.runId,
      vcpuCount: config.vcpuCount,
      memoryMib: config.memoryMib,
      instanceStarted: context.instanceStarted,
      guestConnection: context.guestConnection ?? null,
    }, null, 2)}\n`,
  );
  await writeBounded(
    'confinement.json',
    `${JSON.stringify(context.confinementEvidence ?? null, null, 2)}\n`,
  );
}
