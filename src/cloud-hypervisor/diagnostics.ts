import { constants, promises as fs } from 'fs';
import * as path from 'path';
import type { ExecaChildProcess } from 'execa';
import type { MicrovmNetworkLifecycle, MicrovmNetworkPlan } from '../microvm/network';
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
  CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES,
  CLOUD_HYPERVISOR_LOG_NAME,
  CLOUD_HYPERVISOR_SERIAL_LOG_NAME,
  formatError,
  type CloudHypervisorIdentity,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorRunPaths,
} from './manager-types';
import type { VirtiofsdDevice } from './virtiofsd';

/** Reads at most `maxBytes` from the end of `filePath`. */
export async function readBoundedTail(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(buffer, 0, length, size - length);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Retains only the trailing `maximumBytes` of an unbounded output stream. */
export class BoundedOutputCapture {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, next]);
    if (this.buffer.length > this.maximumBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maximumBytes);
    }
  }

  contents(): Buffer {
    return this.buffer;
  }
}

/**
 * Creates the private run-directory chain with real traversal
 * permissions for the non-root target identity: the two ancestor
 * levels (`CLOUD_HYPERVISOR_RUN_ROOT` and the per-binary directory
 * beneath it) are `0711` root-owned (executable/traversable by any uid,
 * but not listable), and only the per-run leaf directory is chowned to
 * the target identity with `0700` (so only that identity, or root, can
 * actually read its contents). See the `CLOUD_HYPERVISOR_RUN_ROOT`
 * comment in `./manager-types.ts` for why this can't simply live under
 * `workDir`.
 */
export async function prepareRunDirectory(
  dependencies: CloudHypervisorManagerDependencies,
  paths: CloudHypervisorRunPaths,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const binaryDir = path.dirname(paths.runDirectory);
  await dependencies.mkdir(paths.runBaseDir, { recursive: true, mode: 0o711 });
  await dependencies.chmod(paths.runBaseDir, 0o711);
  await dependencies.mkdir(binaryDir, { recursive: true, mode: 0o711 });
  await dependencies.chmod(binaryDir, 0o711);
  await dependencies.mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
  await dependencies.chown(paths.runDirectory, identity.uid, identity.gid);
}

export async function stageArtifact(
  dependencies: CloudHypervisorManagerDependencies,
  source: string,
  destination: string,
  mode: number,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  await dependencies.copyFile(source, destination, constants.COPYFILE_EXCL);
  await dependencies.chown(destination, identity.uid, identity.gid);
  await dependencies.chmod(destination, mode);
}

export async function stageDiagnosticFile(
  dependencies: CloudHypervisorManagerDependencies,
  destination: string,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  await dependencies.writeFile(destination, '', { flag: 'wx', mode: 0o600 });
  await dependencies.chown(destination, identity.uid, identity.gid);
}

async function copyBoundedDiagnostic(
  dependencies: CloudHypervisorManagerDependencies,
  source: string,
  destination: string,
): Promise<void> {
  try {
    const bounded = await dependencies.readFileTail(source, CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
    await dependencies.writeFile(destination, bounded, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function waitForApiSocket(
  dependencies: CloudHypervisorManagerDependencies,
  paths: CloudHypervisorRunPaths,
  apiTimeoutMs: number,
  child: ExecaChildProcess<string> | undefined,
): Promise<void> {
  const deadline = Date.now() + apiTimeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode != null || child.signalCode != null)) {
      throw new Error(
        `Cloud Hypervisor exited before API readiness with code ${child.exitCode ?? 'null'} ` +
        `and signal ${child.signalCode ?? 'null'}`,
      );
    }
    try {
      await dependencies.access(paths.apiSocketPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    await dependencies.sleep(25);
  }
  throw new Error(
    `Cloud Hypervisor API socket was not ready after ${apiTimeoutMs}ms: ` +
    paths.apiSocketPath,
  );
}

export interface CloudHypervisorDiagnosticsContext {
  dependencies: CloudHypervisorManagerDependencies;
  paths: CloudHypervisorRunPaths;
  config: CloudHypervisorOptions;
  stdoutCapture: BoundedOutputCapture;
  stderrCapture: BoundedOutputCapture;
  network: MicrovmNetworkLifecycle | undefined;
  networkPlan: MicrovmNetworkPlan | undefined;
  client: CloudHypervisorApiClient | undefined;
  instanceStarted: boolean;
  // Snapshotted by stop(), before any shutdown attempt, since the API
  // socket becomes unresponsive once the process is asked to exit.
  lastVmInfo: CloudHypervisorVmInfo | undefined;
  lastVmCounters: CloudHypervisorVmCounters | undefined;
  fsDevices: readonly VirtiofsdDevice[];
}

export async function collectCloudHypervisorDiagnostics(
  directory: string,
  context: CloudHypervisorDiagnosticsContext,
): Promise<void> {
  const { dependencies, paths, config } = context;
  await dependencies.mkdir(directory, { recursive: true, mode: 0o700 });
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
  const writeBounded = async (fileName: string, contents: Buffer): Promise<void> => {
    const destination = path.join(directory, fileName);
    await dependencies.writeFile(destination, contents, { mode: 0o600 });
  };
  await writeBounded('launcher-stdout.log', context.stdoutCapture.contents());
  await writeBounded('launcher-stderr.log', context.stderrCapture.contents());
  await copyBoundedDiagnostic(
    dependencies,
    paths.logPath,
    path.join(directory, CLOUD_HYPERVISOR_LOG_NAME),
  );
  await copyBoundedDiagnostic(
    dependencies,
    paths.serialLogPath,
    path.join(directory, CLOUD_HYPERVISOR_SERIAL_LOG_NAME),
  );
  for (const [index, device] of context.fsDevices.entries()) {
    await copyBoundedDiagnostic(
      dependencies,
      device.logPath,
      path.join(directory, `virtiofs-${index}-${device.export.tag}.log`),
    );
  }
  await dependencies.writeFile(
    path.join(directory, 'network-plan.json'),
    `${JSON.stringify(context.networkPlan ?? null, null, 2)}\n`,
    { mode: 0o600 },
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
  await dependencies.writeFile(
    path.join(directory, 'network-diagnostics.txt'),
    `${networkDiagnostics}\n`,
    { mode: 0o600 },
  );
  await dependencies.writeFile(
    path.join(directory, 'counters.json'),
    `${JSON.stringify(counters, null, 2)}\n`,
    { mode: 0o600 },
  );
  await dependencies.writeFile(
    path.join(directory, 'vm-info.json'),
    `${JSON.stringify(vmInfo, null, 2)}\n`,
    { mode: 0o600 },
  );
  await dependencies.writeFile(
    path.join(directory, 'runtime.json'),
    `${JSON.stringify({
      runtime: 'cloud-hypervisor',
      version: CLOUD_HYPERVISOR_RELEASE_VERSION,
      runId: paths.runId,
      vcpuCount: config.vcpuCount,
      memoryMib: config.memoryMib,
      instanceStarted: context.instanceStarted,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
