import { promises as fs } from 'fs';
import * as path from 'path';
import { normalizeAgentPolicy } from '../enclave/execution-policy';
import { readBoundedEnclaveResult as readBoundedCloudHypervisorEnclaveResult } from '../enclave/invocation-result';
export { readBoundedEnclaveResult as readBoundedCloudHypervisorEnclaveResult } from '../enclave/invocation-result';
import type {
  HostEnclaveExecutorBackend,
  HostExecutorInvocationPlan,
  HostExecutorRunState,
  HostExecutorBackendResult,
} from '../enclave/host-executor-server';
import { HOST_EXECUTOR_MAX_RESULT_BYTES, HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import {
  HostExecutorResourceJournal,
  reapHostExecutorResources,
} from '../enclave/host-executor-resource-journal';
import { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import {
  hostExecutorJournalDirectory,
  hostExecutorVmRunId,
} from '../enclave/host-executor-journal';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';
import { guestExecutionFailureReason } from '../microvm/vsock-client';
import { projectEnclaveSessionDiagnostics, readEnclaveSessionDiagnostics } from './enclave-session-diagnostics';
import { Writable } from 'stream';
import { preservePublicEnclaveSession } from './diagnostics';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import {
  assertBoundedEnclaveStorage, mountBoundedEnclaveStorage, unmountBoundedEnclaveStorage,
} from './enclave-storage';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  createArtifactSnapshot,
  createCommonArtifactSnapshot,
  type CloudHypervisorArtifactSnapshot,
} from './artifact-snapshot';
import { calculateSha256 } from './artifact-trust';
import type { CloudHypervisorEnclaveRole } from './enclave-artifact-manifest';
import {
  resolveCloudHypervisorEnclaveExportPlan,
  type CloudHypervisorEnclaveExportPlan,
} from './enclave-export-plan';
import {
  CloudHypervisorManager,
  resolveCloudHypervisorManagerDependencies,
} from './manager';
import type {
  CloudHypervisorManagerDependencies,
  CloudHypervisorManagerGuestConfig,
} from './manager-types';
import type { CloudHypervisorCommonPreflightResult, CloudHypervisorPreflightResult } from './preflight';
import { copySparseFileWithRsync, runCloudHypervisorCommonPreflight } from './preflight';
import {
  preflightCloudHypervisorEnclaveArtifacts,
  resolveTrustedAttestationTool,
} from './enclave-artifact-preflight';
import {
  agentEnvironment,
  prepareInvocationFilesystem,
  stageInvocationInputs,
} from './enclave-invocation-staging';
import type {
  CreateCloudHypervisorHostEnclaveExecutorOptions,
  HostEnclaveExecutorDependencies,
  HostEnclaveExecutorManager,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';
import {
  CLOUD_HYPERVISOR_ENCLAVE_ENTRYPOINTS,
  CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES,
  createAgentEnclaveCloudHypervisorProfile,
  createScriptEnclaveCloudHypervisorProfile,
  type CloudHypervisorWorkloadProfile,
} from './workload-profile';

export type {
  CloudHypervisorEnclaveArtifactPreflightOptions,
  CreateCloudHypervisorHostEnclaveExecutorOptions,
  HostEnclaveExecutorDependencies,
  HostEnclaveExecutorManager,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';
export { preflightCloudHypervisorEnclaveArtifacts } from './enclave-artifact-preflight';

const OUTPUT_NAME = 'out';

const defaultDependencies: HostEnclaveExecutorDependencies = {
  createArtifactSnapshot: (sources, copy, onDirectoryCreated, report) =>
    createArtifactSnapshot(sources, copy, onDirectoryCreated, undefined, report),
  createCommonArtifactSnapshot: (sources, copy, onDirectoryCreated, report) =>
    createCommonArtifactSnapshot(sources, copy, onDirectoryCreated, undefined, report),
  createResourceJournal: (run, plan, vmRunId) => HostExecutorResourceJournal.create(run, plan, vmRunId),
  copySparseFile: copySparseFileWithRsync,
  removeArtifactSnapshot: async (directory) => fs.rm(directory, { recursive: true, force: true }),
  createManager: (
    config, workDir, profile, runId, artifacts, managerDependencies, launchReport, managerStartReport,
  ) => new CloudHypervisorManager(
    config,
    workDir,
    managerDependencies,
    runId,
    profile,
    undefined,
    artifacts,
    true,
    launchReport,
    managerStartReport,
  ),
  mountTmpfs: mountBoundedEnclaveStorage,
  unmount: unmountBoundedEnclaveStorage,
  verifyStorage: assertBoundedEnclaveStorage,
  mkdir: fs.mkdir,
  realpath: fs.realpath,
  lstat: fs.lstat,
  writeFile: fs.writeFile,
  chmod: fs.chmod,
  chown: fs.chown,
  rm: fs.rm,
  resolveIdentity: () => {
    const uid = Number(process.env.SUDO_UID ?? process.getuid?.());
    const gid = Number(process.env.SUDO_GID ?? process.getgid?.());
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1) {
      throw new Error('Cloud Hypervisor enclave storage requires a non-root operator uid/gid');
    }
    return { uid, gid };
  },
};

function filePath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

/**
 * Performs all trusted host/artifact checks before returning an executor that
 * can be passed to createHostExecutorServer. This is intentionally not called
 * by user-facing runtime selection while the Cloud Hypervisor enclave gate is
 * closed.
 */
export async function createCloudHypervisorHostEnclaveExecutor(
  options: CreateCloudHypervisorHostEnclaveExecutorOptions,
  dependencies: Partial<HostEnclaveExecutorDependencies> = {},
): Promise<CloudHypervisorHostEnclaveExecutorBackend> {
  options.onPreflightStage?.('artifact-preflight');
  const environment = options.environment ?? process.env;
  const releaseTag = options.config.artifactReleaseTag;
  const manifestPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST;
  const manifestBundlePath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE;
  const scriptRootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS;
  const agentRootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS;
  const rootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS;
  if (!releaseTag || !manifestPath || !manifestBundlePath
    || (!rootfsPath && (!scriptRootfsPath || !agentRootfsPath))) {
    throw new Error('Cloud Hypervisor enclave artifacts have not been staged and verified');
  }
  const attestationToolPath = await resolveTrustedAttestationTool(environment);
  options.onPreflightStage?.('host-preflight');
  const preflight = await (dependencies.preflight ?? runCloudHypervisorCommonPreflight)(options.config);
  try {
    options.onPreflightStage?.('recovery');
    await reapHostExecutorResources(
      hostExecutorJournalDirectory(options.runState),
      options.managerDependencies?.cleanupRegistry ?? new DurableCloudHypervisorCleanupRegistry(),
      preflight.tools,
    );
    options.onPreflightStage?.('artifact-preflight');
    const enclaveArtifacts = await (dependencies.preflightEnclaveArtifacts ?? preflightCloudHypervisorEnclaveArtifacts)({
      releaseTag,
      manifestPath,
      manifestBundlePath,
      rootfsPath,
      scriptRootfsPath,
      agentRootfsPath,
      attestationToolPath,
    }, undefined, undefined, new HostPreflightReporter('bounded-artifacts', options.onHostPreflight,
      undefined, { phase: 'preflight', profile: 'common' }));
    return new CloudHypervisorHostEnclaveExecutorBackend({
      runState: options.runState,
      config: options.config,
      workDir: options.workDir,
      publicDebugArtifactDirectory: options.publicDebugArtifactDirectory,
      publicDebugArtifactProtectedRoot: options.publicDebugArtifactProtectedRoot,
      preflight,
      enclaveArtifacts,
      agentPolicies: options.agentPolicies,
      managerDependencies: options.managerDependencies,
      ownsPreflightSnapshot: dependencies.preflight === undefined,
    }, dependencies);
  } catch (error) {
    await (dependencies.removeArtifactSnapshot ?? defaultDependencies.removeArtifactSnapshot)(
      preflight.artifactSnapshotDirectory,
    );
    throw error;
  }
}

function createWorkloadProfile(
  plan: HostExecutorInvocationPlan,
  exportPlan: CloudHypervisorEnclaveExportPlan,
  artifacts: CloudHypervisorPreflightResult,
  agentPolicy: HostExecutorAgentPolicy | undefined,
  publicFixtureDebug: boolean,
): CloudHypervisorWorkloadProfile {
  const resourceProfile = exportPlan.role === 'script'
    ? CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script
    : CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent;
  const guest: Omit<CloudHypervisorManagerGuestConfig, 'exports' | 'workspaceMount'> = {
    supervisorBinaryPath: artifacts.supervisorPath,
    supervisorSha256: artifacts.artifactDigests.supervisor,
    identity: { uid: resourceProfile.uid, gid: resourceProfile.gid },
  };
  if (exportPlan.role === 'script') {
    return createScriptEnclaveCloudHypervisorProfile({
      enclaveId: plan.entryId,
      invocationId: plan.invocationId,
      guest,
      exportPlan,
      ...(publicFixtureDebug ? { publicFixtureDebug: true } : {}),
    });
  }
  if (!agentPolicy) throw new Error('Trusted agent policy is required for an agent enclave');
  return createAgentEnclaveCloudHypervisorProfile({
    enclaveId: plan.entryId,
    invocationId: plan.invocationId,
    guest,
    exportPlan,
    ...(publicFixtureDebug ? { publicFixtureDebug: true } : {}),
    apiProxy: {
      ip: ENCLAVE_AGENT_API_PROXY_IP,
      engine: 'copilot',
      profile: agentPolicy.profile,
    },
    ...(agentPolicy.githubAgentId !== undefined
      ? { githubDataPlane: { ip: ENCLAVE_AGENT_GITHUB_MCP_IP, port: ENCLAVE_GITHUB_MCP_PORT } }
      : {}),
  });
}

/**
 * Trusted host-side executor. The broker can select only a pre-admitted
 * static seed and finite-schema payload; all VM, network, storage, deadline,
 * credential, and agent settings are host-derived.
 */
export class CloudHypervisorHostEnclaveExecutorBackend implements HostEnclaveExecutorBackend {
  private readonly dependencies: HostEnclaveExecutorDependencies;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      readonly runState: HostExecutorRunState;
      readonly config: CloudHypervisorOptions;
      readonly workDir: string;
      readonly publicDebugArtifactDirectory?: string;
      readonly publicDebugArtifactProtectedRoot?: string;
      readonly preflight: CloudHypervisorCommonPreflightResult;
      readonly enclaveArtifacts: VerifiedCloudHypervisorEnclaveArtifacts;
      readonly agentPolicies?: Readonly<Record<string, HostExecutorAgentPolicy>>;
      readonly managerDependencies?: CloudHypervisorManagerDependencies;
      readonly ownsPreflightSnapshot?: boolean;
    },
    dependencies: Partial<HostEnclaveExecutorDependencies> = {},
  ) {
    if (
      !options.config.previewEnabled ||
      options.config.developmentAllowUnattestedArtifacts === true ||
      options.config.artifactReleaseTag !== options.enclaveArtifacts.manifest.release.tag
    ) {
      throw new Error('Host enclave execution requires the matching trusted Cloud Hypervisor release');
    }
    this.dependencies = { ...defaultDependencies, ...dependencies };
    if (
      Boolean(options.config.enclaveDebugPublic) !== Boolean(options.publicDebugArtifactDirectory)
      || Boolean(options.publicDebugArtifactDirectory) !== Boolean(options.publicDebugArtifactProtectedRoot)
    ) {
      throw new Error('Public enclave debug requires host-verified public fixtures and a protected artifact directory');
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.options.ownsPreflightSnapshot
      ? this.dependencies.removeArtifactSnapshot(this.options.preflight.artifactSnapshotDirectory)
      : Promise.resolve();
    return this.closePromise;
  }

  async execute(
    plan: HostExecutorInvocationPlan,
    signal: AbortSignal,
  ): Promise<HostExecutorBackendResult> {
    if (this.closed) return { outcome: 'executor-failure' };
    if (signal.aborted) return { outcome: 'cancelled' };
    if (plan.selector !== undefined || plan.seedHostPath === undefined) {
      return { outcome: 'executor-failure' };
    }
    const diagnostic = new HostExecutorInvocationDiagnostics(this.options.runState, plan);
    const maxWrapperStderrBytes = 16 * 1024;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let pendingStderrLine = Buffer.alloc(0);
    let discardStderrLine = false;
    const retainStderrLine = (line: Buffer): void => {
      const record = Buffer.concat([line, Buffer.from('\n')]);
      if (record.length > maxWrapperStderrBytes) return;
      stderrChunks.push(record);
      stderrBytes += record.length;
      while (stderrBytes > maxWrapperStderrBytes) {
        stderrBytes -= stderrChunks.shift()!.length;
      }
    };
    const wrapperStderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(0x0a, offset);
          const end = newline < 0 ? chunk.length : newline;
          const segment = chunk.subarray(offset, end);
          if (discardStderrLine) {
            if (newline < 0) break;
            discardStderrLine = false;
            offset = newline + 1;
            continue;
          }
          if (pendingStderrLine.length + segment.length + 1 > maxWrapperStderrBytes) {
            pendingStderrLine = Buffer.alloc(0);
            if (newline < 0) {
              discardStderrLine = true;
              break;
            }
            offset = newline + 1;
            continue;
          }
          pendingStderrLine = Buffer.concat([pendingStderrLine, segment]);
          if (newline < 0) break;
          retainStderrLine(pendingStderrLine);
          pendingStderrLine = Buffer.alloc(0);
          offset = newline + 1;
        }
        callback();
      },
    });
    const report = new HostPreflightReporter(
      'host-invocation',
      diagnostic.publish,
      (failedReport, _id, error) => diagnostic.classifyFailure(failedReport, error),
    );
    const check = <T>(id: Parameters<HostPreflightReporter['check']>[0], operation: () => Promise<T> | T) =>
      diagnostic.check(report, id, operation);
    const role: CloudHypervisorEnclaveRole = plan.executorKind;
    const agentPolicies = this.options.agentPolicies;
    const rawAgentPolicy = agentPolicies &&
      Object.prototype.hasOwnProperty.call(agentPolicies, plan.entryId)
      ? agentPolicies[plan.entryId]
      : undefined;
    const policy = await check('policy', () => role === 'agent'
      ? normalizeAgentPolicy(rawAgentPolicy, plan.timeoutMs)
      : undefined);
    const verifiedRootfs = this.options.enclaveArtifacts.rootfs[
      this.options.enclaveArtifacts.manifest.schemaVersion === 2 ? 'script' : role
    ];
    const filesystemState: {
      mounted: boolean;
      invocationDirectoryCreated: boolean;
      timedOut: boolean;
      aborted: boolean;
    } = {
      mounted: false,
      invocationDirectoryCreated: false,
      timedOut: false,
      aborted: signal.aborted,
    };
    let snapshot: CloudHypervisorArtifactSnapshot | undefined;
    let manager: HostEnclaveExecutorManager | undefined;
    let stopPromise: Promise<void> | undefined;
    let managerStopped = false;
    let outcome: HostExecutorBackendResult = { outcome: 'executor-failure' };
    let guestWorkloadFailed = false;
    let cleanupError: unknown;
    const pendingWork = new Set<Promise<unknown>>();
    let filesystemCleanupPromise: Promise<void> | undefined;
    const runId = hostExecutorVmRunId(plan);
    let invocationStorage: Awaited<ReturnType<NonNullable<HostEnclaveExecutorDependencies['prepareInvocationStorage']>>> | undefined;
    let dependencies = this.dependencies;
    let resourceJournal: Awaited<ReturnType<HostEnclaveExecutorDependencies['createResourceJournal']>> | undefined;
    const cleanupInvocationFilesystem = (): Promise<void> => {
      if (filesystemCleanupPromise) return filesystemCleanupPromise;
      filesystemCleanupPromise = (async () => {
        if (filesystemState.mounted) {
          if (invocationStorage) {
            await dependencies.verifyStorage(plan.invocationHostDir,
              CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[role].writableStorageBytes);
          }
          await resourceJournal?.verifyMount();
          await dependencies.unmount(plan.invocationHostDir, this.options.preflight.tools);
          filesystemState.mounted = false;
          await resourceJournal?.verifyDirectory();
          await dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
          filesystemState.invocationDirectoryCreated = false;
        } else if (filesystemState.invocationDirectoryCreated) {
          await resourceJournal?.verifyDirectory();
          await dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
          filesystemState.invocationDirectoryCreated = false;
        }
      })().catch((error) => {
        filesystemCleanupPromise = undefined;
        throw error;
      });
      return filesystemCleanupPromise;
    };
    const trackFilesystemWork = <T>(operation: Promise<T>): Promise<T> => {
      const tracked = operation.finally(() => pendingWork.delete(tracked));
      pendingWork.add(tracked);
      return tracked;
    };
    const stopManager = async (): Promise<void> => {
      if (!manager) return;
      if (!stopPromise) {
        diagnostic.milestone('manager-stop-start');
        stopPromise = manager.stop().then(() => { diagnostic.milestone('manager-stop-complete'); });
      }
      try {
        await stopPromise;
      } catch (error) {
        stopPromise = undefined;
        throw error;
      }
    };
    let rejectInterruption: ((error: Error) => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    void interruption.catch(() => undefined);
    const raceInterruption = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, interruption]);
    const abortManager = (): void => {
      filesystemState.aborted = true;
      diagnostic.milestone(filesystemState.timedOut ? 'deadline-expired' : 'cancellation');
      void manager?.cancel('host executor cancelled').catch(() => undefined);
      if (manager) void stopManager().catch(() => undefined);
      rejectInterruption?.(markHostPreflightError(new Error('Host executor invocation was interrupted'),
        filesystemState.timedOut ? 'invocation-timeout' : 'invocation-cancelled'));
    };
    signal.addEventListener('abort', abortManager, { once: true });
    const deadline = setTimeout(() => {
      filesystemState.timedOut = true;
      abortManager();
    }, plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS);
    try {
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await check('filesystem', () => raceInterruption(trackFilesystemWork(prepareInvocationFilesystem(
        this.options.runState,
        plan,
        role,
        {
          ...dependencies,
          mountTmpfs: (...args) => dependencies.mountTmpfs(...args),
          verifyStorage: (...args) => dependencies.verifyStorage(...args),
        },
        this.options.preflight.tools,
        async () => {
          resourceJournal = await this.dependencies.createResourceJournal(this.options.runState, plan, runId);
          diagnostic.resourcePublished(this.options.runState, plan);
          if (this.dependencies.prepareInvocationStorage) {
            invocationStorage = await this.dependencies.prepareInvocationStorage(
              this.options.runState, plan, resourceJournal as HostExecutorResourceJournal, this.options.preflight.tools,
              report.fork('bounded-runtime'),
            );
            dependencies = { ...dependencies, ...invocationStorage.dependencies };
          }
        },
        async () => {
          filesystemState.invocationDirectoryCreated = true;
          await resourceJournal?.captureDirectory();
        },
        async () => {
          filesystemState.mounted = true;
          await resourceJournal?.captureMount();
        },
      ))));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const exportPlan = await check('export-plan', () => raceInterruption(
        resolveCloudHypervisorEnclaveExportPlan({
          runId: this.options.runState.runId,
          seedsDir: this.options.runState.seedsDir,
          invocationsDir: this.options.runState.invocationsDir,
          entries: this.options.runState.entries,
        }, plan),
      ));
      snapshot = await check('snapshot', async () => {
        await resourceJournal?.prepareSnapshot();
        const snapshotPromise = trackFilesystemWork(dependencies.createArtifactSnapshot({
          cloudHypervisorBinary: this.options.preflight.cloudHypervisorBinary,
          virtiofsdBinary: this.options.preflight.virtiofsdBinary,
          kernelPath: this.options.preflight.kernelPath,
          rootfsPath: verifiedRootfs.path,
          supervisorPath: this.options.preflight.supervisorPath,
          manifestPath: this.options.enclaveArtifacts.manifestPath,
          bundlePath: this.options.enclaveArtifacts.manifestBundlePath,
        }, (source, destination) => dependencies.copySparseFile(
          this.options.preflight.tools.rsync,
          source,
          destination,
        ), async (directory) => resourceJournal?.captureSnapshot(directory),
        report.fork('artifact-snapshot')).then(async (created) => {
          snapshot = created;
          await resourceJournal?.captureSnapshot(created.directory);
          return created;
        }));
        return raceInterruption(snapshotPromise);
      });
      const createdSnapshot = snapshot;
      if (!('rootfsPath' in createdSnapshot) || typeof createdSnapshot.rootfsPath !== 'string') {
        throw new Error('Enclave invocation rootfs snapshot is missing');
      }
      await check('snapshot-digest', async () => {
        const snapshotRootfsStat = await raceInterruption(dependencies.lstat(createdSnapshot.rootfsPath));
        if (
          snapshotRootfsStat.isSymbolicLink() ||
          !snapshotRootfsStat.isFile() ||
          snapshotRootfsStat.size !== verifiedRootfs.artifact.sizeBytes ||
          await raceInterruption(calculateSha256(createdSnapshot.rootfsPath)) !== verifiedRootfs.artifact.sha256
        ) {
          throw markHostPreflightError(
            new Error('Enclave rootfs snapshot does not match its attested artifact digest'), 'digest-mismatch');
        }
        if (invocationStorage) {
          for (const [file, digest] of [
            [createdSnapshot.cloudHypervisorBinary, this.options.preflight.artifactDigests.cloudHypervisor],
            [createdSnapshot.virtiofsdBinary, this.options.preflight.artifactDigests.virtiofsd],
            [createdSnapshot.kernelPath, this.options.preflight.artifactDigests.kernel],
            [createdSnapshot.supervisorPath, this.options.preflight.artifactDigests.supervisor],
          ]) {
            if (!digest || await calculateSha256(file!) !== digest) {
              throw markHostPreflightError(new Error('Invocation artifact digest changed'), 'digest-mismatch');
            }
          }
        }
      });
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const artifacts: CloudHypervisorPreflightResult = {
        ...this.options.preflight,
        cloudHypervisorBinary: createdSnapshot.cloudHypervisorBinary,
        virtiofsdBinary: createdSnapshot.virtiofsdBinary,
        kernelPath: createdSnapshot.kernelPath,
        rootfsPath: createdSnapshot.rootfsPath,
        supervisorPath: createdSnapshot.supervisorPath,
        artifactSnapshotDirectory: createdSnapshot.directory,
        artifactDigests: {
          ...this.options.preflight.artifactDigests,
          rootfs: verifiedRootfs.artifact.sha256,
          supervisor: this.options.preflight.artifactDigests.supervisor,
        },
      };
      const profile = await check('workload-profile', () => createWorkloadProfile(
        plan, exportPlan, artifacts, policy, Boolean(this.options.publicDebugArtifactDirectory),
      ));
      await check('input-staging', () => raceInterruption(trackFilesystemWork(
        stageInvocationInputs(plan, role, policy, dependencies),
      )));
      const managerConfig = {
        ...this.options.config,
        cloudHypervisorBinary: artifacts.cloudHypervisorBinary,
      };
      const managerDependencies = invocationStorage?.managerDependencies ?? this.options.managerDependencies;
      const debugDirectory = this.options.publicDebugArtifactDirectory;
      manager = await check('manager-create', () => dependencies.createManager(
        managerConfig,
        invocationStorage?.workDir ?? this.options.workDir,
        profile,
        runId,
        artifacts,
        debugDirectory
          ? {
              ...resolveCloudHypervisorManagerDependencies(managerDependencies),
              enclaveDebugArtifactDirectory: path.join(debugDirectory, runId),
              enclaveDebugArtifactProtectedRoot: this.options.publicDebugArtifactProtectedRoot,
            }
          : managerDependencies,
        report.fork('vm-launch'),
        report,
      ));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await check('manager-start', () => raceInterruption(trackFilesystemWork(manager!.start())));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await check('instance-start', () => raceInterruption(trackFilesystemWork(manager!.startInstance())));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const executionResult = await check('guest-execute', () => raceInterruption(manager!.execute({
        argv: [CLOUD_HYPERVISOR_ENCLAVE_ENTRYPOINTS[role]],
        cwd: '/',
        uid: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[role].uid,
        gid: CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[role].gid,
        timeoutMs: plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS,
        env: role === 'agent' && policy ? {
          ...agentEnvironment(policy, plan),
          ...(debugDirectory ? { AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS: 'true' } : {}),
        } : {},
        onDiagnostics: diagnostic.guestExecution,
        ...(role === 'agent' ? { stderr: wrapperStderr } : {}),
      }).catch((error: unknown) => {
        const reason = guestExecutionFailureReason(error);
        throw reason ? markHostPreflightError(error, reason) : error;
      })));
      diagnostic.milestone('guest-complete');
      if (filesystemState.timedOut || executionResult.timedOut) {
        diagnostic.fail(report, 'guest-execute', markHostPreflightError(
          new Error('Host executor invocation timed out'), 'invocation-timeout'));
        outcome = { outcome: 'timeout' };
      } else if (filesystemState.aborted || signal.aborted) {
        diagnostic.fail(report, 'guest-execute', markHostPreflightError(
          new Error('Host executor invocation was cancelled'), 'invocation-cancelled'));
        outcome = { outcome: 'cancelled' };
      } else if (executionResult.exitCode !== 0 || executionResult.signal !== null) {
        diagnostic.fail(report, 'guest-execute', markHostPreflightError(
          new Error('Host executor guest command failed'), 'command-failed'));
        outcome = { outcome: 'executor-failure' };
        guestWorkloadFailed = true;
      } else {
        // Result reads require the VM to have stopped, but cleanup failures
        // must remain distinct from the invocation's original failure.
        const cleanupReport = report.fork('host-invocation-cleanup');
        await diagnostic.check(cleanupReport, 'manager-stop', () => raceInterruption(stopManager()));
        managerStopped = true;
        await diagnostic.check(cleanupReport, 'manager-record', () => raceInterruption(manager!.completeCleanupRecord()));
        if (filesystemState.timedOut || filesystemState.aborted || signal.aborted) {
          outcome = filesystemState.timedOut ? { outcome: 'timeout' } : { outcome: 'cancelled' };
        } else {
          const outputPath = filePath(filePath(plan.invocationHostDir, 'output'), OUTPUT_NAME);
          const maxBytes = role === 'agent'
            ? policy?.maxOutputBytes ?? HOST_EXECUTOR_MAX_RESULT_BYTES
            : HOST_EXECUTOR_MAX_RESULT_BYTES;
          diagnostic.milestone('result-read-start');
          const resultValue = await check('result-read', () => raceInterruption(readBoundedCloudHypervisorEnclaveResult(
            outputPath,
            plan.schema,
            maxBytes,
          )));
          diagnostic.milestone('result-read-complete');
          outcome = resultValue === undefined
            ? { outcome: 'schema-failure' }
            : { outcome: 'success', result: resultValue };
          if (resultValue === undefined) {
            diagnostic.fail(report, 'result-read', markHostPreflightError(
              new Error('Host executor result is invalid'), 'result-invalid'));
          }
        }
      }
    } catch {
      outcome = filesystemState.timedOut
        ? { outcome: 'timeout' }
        : filesystemState.aborted || signal.aborted
        ? { outcome: 'cancelled' }
        : { outcome: 'executor-failure' };
    } finally {
      diagnostic.milestone('work-complete', outcome.outcome);
      diagnostic.milestone('cleanup-start');
      signal.removeEventListener('abort', abortManager);
      clearTimeout(deadline);
      const cleanupReport = report.fork('host-invocation-cleanup');
      const cleanupCheck = <T>(id: Parameters<HostPreflightReporter['check']>[0], operation: () => Promise<T>) =>
        diagnostic.check(cleanupReport, id, operation);
      // Interrupted staging/startup can still create resources. Drain every
      // such operation before removing exports or reporting terminal.
      await cleanupCheck('pending-work', () => Promise.allSettled([...pendingWork]));
      if (manager && stopPromise) {
        await stopPromise.catch(() => undefined);
        stopPromise = undefined;
      }
      if (manager && !managerStopped) {
        try {
          await cleanupCheck('manager-stop', stopManager);
          managerStopped = true;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (manager && managerStopped) {
        try {
          await cleanupCheck('manager-record', () => manager!.completeCleanupRecord());
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      }
      if (role === 'agent' && managerStopped && filesystemState.mounted) {
        try {
          if (stderrBytes) {
            diagnostic.guestFileOperations(projectEnclaveSessionDiagnostics(Buffer.concat(stderrChunks)));
          }
          await resourceJournal?.verifyMount();
          diagnostic.guestSession(await (dependencies.readSessionDiagnostics ?? readEnclaveSessionDiagnostics)(
            plan.invocationHostDir,
            undefined,
            undefined,
            this.options.publicDebugArtifactDirectory
              ? (contents) => (dependencies.preservePublicSession ?? preservePublicEnclaveSession)(
                  path.join(this.options.publicDebugArtifactDirectory!, runId),
                  this.options.publicDebugArtifactProtectedRoot!,
                  contents,
                  policy ? [
                    policy.githubBearer ?? '', policy.githubAgentId ?? '', policy.modelBudgetSecret ?? '',
                    agentEnvironment(policy, plan).COPILOT_TOKEN,
                  ] : [],
                  resolveCloudHypervisorManagerDependencies(
                    invocationStorage?.managerDependencies ?? this.options.managerDependencies,
                  ),
                )
              : undefined,
          ));
        } catch (error) {
          diagnostic.guestSession({ status: 'read-failed' });
          cleanupError ??= error;
        }
      } else if (role === 'agent' && manager && !managerStopped) {
        diagnostic.guestSession({ status: 'not-stopped' });
      }
      if (snapshot && (!manager || managerStopped) && cleanupError === undefined) {
        try {
          await cleanupCheck('snapshot-remove', async () => {
            await resourceJournal?.verifySnapshot();
            await dependencies.removeArtifactSnapshot(snapshot!.directory);
          });
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      }
      if ((!manager || managerStopped) && cleanupError === undefined) {
        try {
          await cleanupCheck('filesystem-remove', cleanupInvocationFilesystem);
          await cleanupCheck('storage-close', async () => invocationStorage?.close());
          await cleanupCheck('journal-complete', async () => resourceJournal?.complete());
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      } else if (filesystemState.invocationDirectoryCreated && !filesystemState.mounted) {
        try {
          await cleanupCheck('filesystem-remove', async () => {
            await resourceJournal?.verifyDirectory();
            await this.dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
          });
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    diagnostic.milestone('cleanup-complete', cleanupError === undefined ? outcome.outcome : 'executor-failure');
    if (cleanupError !== undefined || diagnostic.persistenceFailed) {
      this.closed = true;
      return { outcome: 'executor-failure', cleanupComplete: false };
    }
    if (guestWorkloadFailed && outcome.outcome === 'executor-failure') {
      return { outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true };
    }
    return outcome;
  }
}
