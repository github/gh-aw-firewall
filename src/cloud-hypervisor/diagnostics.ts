import { constants, promises as fs } from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import type { ExecaChildProcess } from 'execa';
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
  CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES,
  CLOUD_HYPERVISOR_LOG_NAME,
  CLOUD_HYPERVISOR_SERIAL_LOG_NAME,
  formatError,
  type CloudHypervisorIdentity,
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorRunPaths,
} from './manager-types';
import type { VirtiofsdDevice } from './virtiofsd';
import type { CloudHypervisorConfinementEvidence } from './confinement-verifier';

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

async function secureFileHandoff(
  dependencies: AuditDependencies,
  filePath: string,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const handle = await dependencies.open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to hand off non-regular or multiply-linked file: ${filePath}`);
    }
    await handle.chmod(0o600);
    await handle.chown(identity.uid, identity.gid);
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

  writable(): Writable {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.append(chunk);
        callback();
      },
    });
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
  copy?: () => Promise<void>,
): Promise<void> {
  if (copy) await copy();
  else await dependencies.copyFile(source, destination, constants.COPYFILE_EXCL);
  await dependencies.chown(destination, identity.uid, identity.gid);
  await dependencies.chmod(destination, mode);
}

export async function stageDiagnosticFile(
  dependencies: CloudHypervisorManagerDependencies,
  destination: string,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const handle = await dependencies.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to create non-regular diagnostic file: ${destination}`);
    }
    await handle.chmod(0o600);
    await handle.chown(identity.uid, identity.gid);
  } finally {
    await handle.close();
  }
}

export async function preserveVirtiofsdStartupEvidence(
  dependencies: CloudHypervisorManagerDependencies,
  devices: readonly VirtiofsdDevice[],
  directory: string,
): Promise<void> {
  if (devices.length === 0) return;
  const { identity, directory: auditDirectory } = await prepareAuditDirectory(directory, dependencies);
  for (const device of devices) {
    try {
      const destination = path.join(auditDirectory, path.basename(device.evidencePath));
      await dependencies.copyFile(device.evidencePath, destination, constants.COPYFILE_EXCL);
      await secureFileHandoff(dependencies, destination, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function copyBoundedDiagnostic(
  dependencies: CloudHypervisorManagerDependencies,
  source: string,
  destination: string,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  let bounded: Buffer;
  try {
    bounded = await dependencies.readFileTail(source, CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  await writeAuditFile(dependencies, destination, bounded, identity);
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
  guestStdoutCapture: BoundedOutputCapture;
  guestStderrCapture: BoundedOutputCapture;
  captureGuestRawOutput?: boolean;
  network: MicrovmNetworkLifecycle | CloudHypervisorNetworkLifecycle | undefined;
  networkPlan: MicrovmNetworkPlan | undefined;
  client: CloudHypervisorApiClient | undefined;
  instanceStarted: boolean;
  // Snapshotted by stop(), before any shutdown attempt, since the API
  // socket becomes unresponsive once the process is asked to exit.
  lastVmInfo: CloudHypervisorVmInfo | undefined;
  lastVmCounters: CloudHypervisorVmCounters | undefined;
  fsDevices: readonly VirtiofsdDevice[];
  confinementEvidence: CloudHypervisorConfinementEvidence | undefined;
}

type AuditDependencies = Pick<
  CloudHypervisorManagerDependencies,
  'mkdir' | 'lstat' | 'realpath' | 'open' | 'resolveIdentity'
>;

async function assertExistingDiagnosticComponents(
  dependencies: AuditDependencies,
  directory: string,
): Promise<void> {
  const absolutePath = path.resolve(directory);
  const root = path.parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(path.sep).filter(Boolean);
  const cloudHypervisorIndex = segments.lastIndexOf('cloud-hypervisor');
  if (cloudHypervisorIndex < 0) return;
  const diagnosticsIndex = segments.lastIndexOf('diagnostics');
  const protectedIndex = diagnosticsIndex >= 0 && diagnosticsIndex < cloudHypervisorIndex
    ? diagnosticsIndex
    : cloudHypervisorIndex;
  const anchor = path.join(root, ...segments.slice(0, protectedIndex));
  let existingAncestor = anchor;
  const missingSegments: string[] = [];
  while (true) {
    try {
      await dependencies.realpath(existingAncestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  let current = await dependencies.realpath(existingAncestor);
  const descendants = [
    ...missingSegments,
    ...segments.slice(protectedIndex),
  ];
  for (const segment of descendants) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await dependencies.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory path component: ${current}`);
    }
    if ((await dependencies.realpath(current)) !== current) {
      throw new Error(`Refusing to use non-canonical directory path: ${current}`);
    }
  }
}

async function realDirectoryPath(
  dependencies: AuditDependencies,
  directory: string,
): Promise<string> {
  const canonicalDirectory = await dependencies.realpath(directory);
  const root = path.parse(canonicalDirectory).root;
  let current = root;
  for (const segment of canonicalDirectory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await dependencies.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory path component: ${current}`);
    }
    if ((await dependencies.realpath(current)) !== current) {
      throw new Error(`Refusing to use non-canonical directory path: ${current}`);
    }
  }
  const requestedStat = await dependencies.lstat(directory);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new Error(`Refusing to use non-directory path: ${directory}`);
  }
  return canonicalDirectory;
}

async function prepareAuditDirectory(
  directory: string,
  dependencies: AuditDependencies,
): Promise<{ identity: CloudHypervisorIdentity; directory: string }> {
  const identity = dependencies.resolveIdentity();
  const parent = path.dirname(directory);
  if (path.basename(parent) === 'cloud-hypervisor') {
    await prepareAuditDirectory(parent, dependencies);
  }
  await assertExistingDiagnosticComponents(dependencies, directory);
  await dependencies.mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realDirectoryPath(dependencies, directory);
  const handle = await dependencies.open(
    canonicalDirectory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to use non-directory path: ${canonicalDirectory}`);
    }
    await handle.chmod(0o700);
    await handle.chown(identity.uid, identity.gid);
  } finally {
    await handle.close();
  }
  return { identity, directory: canonicalDirectory };
}

async function writeAuditFile(
  dependencies: AuditDependencies,
  destination: string,
  contents: string | Buffer,
  identity: CloudHypervisorIdentity,
): Promise<void> {
  const handle = await dependencies.open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Refusing to write non-regular or multiply-linked file: ${destination}`);
    }
    await handle.chmod(0o600);
    await handle.chown(identity.uid, identity.gid);
    await handle.truncate(0);
    await handle.writeFile(contents);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function writeGuestOutputAudit(
  directory: string,
  dependencies: AuditDependencies,
  stdoutCapture: BoundedOutputCapture,
  stderrCapture: BoundedOutputCapture,
): Promise<void> {
  const { identity, directory: auditDirectory } = await prepareAuditDirectory(directory, dependencies);
  await writeAuditFile(
    dependencies,
    path.join(auditDirectory, 'guest-stdout.raw.log'),
    stdoutCapture.contents(),
    identity,
  );
  await writeAuditFile(
    dependencies,
    path.join(auditDirectory, 'guest-stderr.raw.log'),
    stderrCapture.contents(),
    identity,
  );
}

export async function collectCloudHypervisorDiagnostics(
  directory: string,
  context: CloudHypervisorDiagnosticsContext,
): Promise<void> {
  const { dependencies, paths, config } = context;
  const preparedAuditDirectory = await prepareAuditDirectory(directory, dependencies);
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
    await writeAuditFile(dependencies, destination, contents, identity);
  };
  await writeBounded('launcher-stdout.log', context.stdoutCapture.contents());
  await writeBounded('launcher-stderr.log', context.stderrCapture.contents());
  if (context.captureGuestRawOutput !== false) {
    await writeBounded('guest-stdout.raw.log', context.guestStdoutCapture.contents());
    await writeBounded('guest-stderr.raw.log', context.guestStderrCapture.contents());
  }
  await copyBoundedDiagnostic(
    dependencies,
    paths.logPath,
    path.join(directory, CLOUD_HYPERVISOR_LOG_NAME),
    identity,
  );
  await copyBoundedDiagnostic(
    dependencies,
    paths.serialLogPath,
    path.join(directory, CLOUD_HYPERVISOR_SERIAL_LOG_NAME),
    identity,
  );
  for (const [index, device] of context.fsDevices.entries()) {
    await copyBoundedDiagnostic(
      dependencies,
      device.logPath,
      path.join(directory, `virtiofs-${index}-${device.export.tag}.log`),
      identity,
    );
    await copyBoundedDiagnostic(
      dependencies,
      device.evidencePath,
      path.join(directory, `virtiofs-${index}-${device.export.tag}-confinement.json`),
      identity,
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
    }, null, 2)}\n`,
  );
  await writeBounded(
    'confinement.json',
    `${JSON.stringify(context.confinementEvidence ?? null, null, 2)}\n`,
  );
}
