import { constants, promises as fs } from 'fs';
import { TextDecoder } from 'util';
import * as path from 'path';
import {
  canonicalizeSchemaValue,
  validateValueAgainstSchema,
} from '../bounded-execution/finite-schema';
import type {
  HostEnclaveExecutorBackend,
  HostExecutorInvocationPlan,
  HostExecutorRunState,
  HostExecutorBackendResult,
} from '../enclave/host-executor-server';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from '../enclave/host-executor-protocol';
import {
  HostExecutorResourceJournal,
  hostExecutorJournalDirectory,
  hostExecutorVmRunId,
  reapHostExecutorResources,
} from '../enclave/host-executor-journal';
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
} from './manager';
import type {
  CloudHypervisorManagerDependencies,
  CloudHypervisorManagerGuestConfig,
} from './manager-types';
import type { CloudHypervisorPreflightResult } from './preflight';
import { copySparseFileWithRsync, runCloudHypervisorPreflight } from './preflight';
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

const MAX_AGENT_MODEL_BYTES = 256;
const MAX_GITHUB_BEARER_BYTES = 512;
const OUTPUT_NAME = 'out';
const CREDENTIAL_PATTERN = /^[\x21-\x7e]{16,512}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const defaultDependencies: HostEnclaveExecutorDependencies = {
  createArtifactSnapshot,
  createResourceJournal: (run, plan, vmRunId) => HostExecutorResourceJournal.create(run, plan, vmRunId),
  copySparseFile: copySparseFileWithRsync,
  removeArtifactSnapshot: async (directory) => fs.rm(directory, { recursive: true, force: true }),
  createManager: (config, workDir, profile, runId, artifacts, managerDependencies) => new CloudHypervisorManager(
    config,
    workDir,
    managerDependencies,
    runId,
    profile,
    undefined,
    artifacts,
    true,
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
  const environment = options.environment ?? process.env;
  const releaseTag = options.config.artifactReleaseTag;
  const manifestPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST;
  const manifestBundlePath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE;
  const scriptRootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS;
  const agentRootfsPath = environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS;
  if (!releaseTag || !manifestPath || !manifestBundlePath || !scriptRootfsPath || !agentRootfsPath) {
    throw new Error('Cloud Hypervisor enclave artifacts have not been staged and verified');
  }
  const attestationToolPath = await resolveTrustedAttestationTool(environment);
  const preflight = await runCloudHypervisorPreflight(options.config);
  try {
    await reapHostExecutorResources(
      hostExecutorJournalDirectory(options.runState),
      options.managerDependencies?.cleanupRegistry ?? new DurableCloudHypervisorCleanupRegistry(),
      preflight.tools,
    );
    const enclaveArtifacts = await preflightCloudHypervisorEnclaveArtifacts({
      releaseTag,
      manifestPath,
      manifestBundlePath,
      scriptRootfsPath,
      agentRootfsPath,
      attestationToolPath,
    });
    return new CloudHypervisorHostEnclaveExecutorBackend({
      runState: options.runState,
      config: options.config,
      workDir: options.workDir,
      preflight,
      enclaveArtifacts,
      agentPolicies: options.agentPolicies,
      managerDependencies: options.managerDependencies,
      ownsPreflightSnapshot: true,
    }, dependencies);
  } catch (error) {
    await (dependencies.removeArtifactSnapshot ?? defaultDependencies.removeArtifactSnapshot)(
      preflight.artifactSnapshotDirectory,
    );
    throw error;
  }
}

function normalizeAgentPolicy(
  policy: HostExecutorAgentPolicy | undefined,
  timeoutMs: number,
): HostExecutorAgentPolicy | undefined {
  if (!policy) return undefined;
  if (
    typeof policy.model !== 'string' ||
    policy.model.length === 0 ||
    Buffer.byteLength(policy.model, 'utf8') > MAX_AGENT_MODEL_BYTES ||
    hasControlCharacters(policy.model) ||
    !['openai', 'anthropic'].includes(policy.profile) ||
    !Number.isSafeInteger(policy.maxOutputBytes) ||
    policy.maxOutputBytes < 1 ||
    policy.maxOutputBytes > HOST_EXECUTOR_MAX_RESULT_BYTES ||
    (policy.maxModelRequests !== undefined &&
      (!Number.isSafeInteger(policy.maxModelRequests) || policy.maxModelRequests < 1)) ||
    (policy.maxModelTokens !== undefined &&
      (!Number.isSafeInteger(policy.maxModelTokens) || policy.maxModelTokens < 1)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error('Trusted host executor agent policy is invalid');
  }
  const hasGithubId = policy.githubAgentId !== undefined;
  const hasGithubBearer = policy.githubBearer !== undefined;
  if (hasGithubId !== hasGithubBearer) {
    throw new Error('Trusted GitHub agent identity and bearer must be configured together');
  }
  if (
    (policy.githubAgentId !== undefined && !AGENT_ID_PATTERN.test(policy.githubAgentId)) ||
    (policy.githubBearer !== undefined &&
      (!CREDENTIAL_PATTERN.test(policy.githubBearer) ||
        Buffer.byteLength(policy.githubBearer, 'ascii') > MAX_GITHUB_BEARER_BYTES))
  ) {
    throw new Error('Trusted host executor GitHub credentials are invalid');
  }
  return policy;
}

export async function readBoundedCloudHypervisorEnclaveResult(
  outputPath: string,
  schema: HostExecutorInvocationPlan['schema'],
  maxBytes: number,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) return undefined;
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    const parsed: unknown = JSON.parse(text);
    if (!validateValueAgainstSchema(schema, parsed)) return undefined;
    const canonical = canonicalizeSchemaValue(schema, parsed);
    if (Buffer.byteLength(canonical, 'utf8') > maxBytes) return undefined;
    return canonical;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function createWorkloadProfile(
  plan: HostExecutorInvocationPlan,
  exportPlan: CloudHypervisorEnclaveExportPlan,
  artifacts: CloudHypervisorPreflightResult,
  agentPolicy: HostExecutorAgentPolicy | undefined,
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
    });
  }
  if (!agentPolicy) throw new Error('Trusted agent policy is required for an agent enclave');
  return createAgentEnclaveCloudHypervisorProfile({
    enclaveId: plan.entryId,
    invocationId: plan.invocationId,
    guest,
    exportPlan,
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
      readonly preflight: CloudHypervisorPreflightResult;
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
    const role: CloudHypervisorEnclaveRole = plan.executorKind;
    const agentPolicies = this.options.agentPolicies;
    const rawAgentPolicy = agentPolicies &&
      Object.prototype.hasOwnProperty.call(agentPolicies, plan.entryId)
      ? agentPolicies[plan.entryId]
      : undefined;
    const policy = role === 'agent'
      ? normalizeAgentPolicy(rawAgentPolicy, plan.timeoutMs)
      : undefined;
    const verifiedRootfs = role === 'script'
      ? this.options.enclaveArtifacts.rootfs.script
      : this.options.enclaveArtifacts.rootfs.agent;
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
    let cleanupError: unknown;
    const pendingWork = new Set<Promise<unknown>>();
    let filesystemCleanupPromise: Promise<void> | undefined;
    const runId = hostExecutorVmRunId(plan);
    let resourceJournal: Awaited<ReturnType<HostEnclaveExecutorDependencies['createResourceJournal']>> | undefined;
    const cleanupInvocationFilesystem = (): Promise<void> => {
      if (filesystemCleanupPromise) return filesystemCleanupPromise;
      filesystemCleanupPromise = (async () => {
        if (filesystemState.mounted) {
          await resourceJournal?.verifyMount();
          await this.dependencies.unmount(plan.invocationHostDir, this.options.preflight.tools);
          filesystemState.mounted = false;
          await resourceJournal?.verifyDirectory();
          await this.dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
          filesystemState.invocationDirectoryCreated = false;
        } else if (filesystemState.invocationDirectoryCreated) {
          await resourceJournal?.verifyDirectory();
          await this.dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
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
      if (!stopPromise) stopPromise = manager.stop();
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
      void manager?.cancel('host executor cancelled').catch(() => undefined);
      if (manager) void stopManager().catch(() => undefined);
      rejectInterruption?.(new Error('Host executor invocation was cancelled'));
    };
    signal.addEventListener('abort', abortManager, { once: true });
    const deadline = setTimeout(() => {
      filesystemState.timedOut = true;
      abortManager();
    }, plan.timeoutMs);
    try {
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await raceInterruption(trackFilesystemWork(prepareInvocationFilesystem(
        this.options.runState,
        plan,
        role,
        this.dependencies,
        this.options.preflight.tools,
        async () => {
          resourceJournal = await this.dependencies.createResourceJournal(this.options.runState, plan, runId);
        },
        async () => {
          filesystemState.invocationDirectoryCreated = true;
          await resourceJournal?.captureDirectory();
        },
        async () => {
          filesystemState.mounted = true;
          await resourceJournal?.captureMount();
        },
      )));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const exportPlan = await raceInterruption(
        resolveCloudHypervisorEnclaveExportPlan({
          runId: this.options.runState.runId,
          seedsDir: this.options.runState.seedsDir,
          invocationsDir: this.options.runState.invocationsDir,
          entries: this.options.runState.entries,
        }, plan),
      );
      await resourceJournal?.prepareSnapshot();
      const snapshotPromise = trackFilesystemWork(this.dependencies.createArtifactSnapshot({
        cloudHypervisorBinary: this.options.preflight.cloudHypervisorBinary,
        virtiofsdBinary: this.options.preflight.virtiofsdBinary,
        kernelPath: this.options.preflight.kernelPath,
        rootfsPath: verifiedRootfs.path,
        supervisorPath: this.options.preflight.supervisorPath,
        manifestPath: this.options.enclaveArtifacts.manifestPath,
        bundlePath: this.options.enclaveArtifacts.manifestBundlePath,
      }, (source, destination) => this.dependencies.copySparseFile(
        this.options.preflight.tools.rsync,
        source,
        destination,
      ), async (directory) => resourceJournal?.captureSnapshot(directory)).then(async (created) => {
        snapshot = created;
        await resourceJournal?.captureSnapshot(created.directory);
        return created;
      }));
      snapshot = await raceInterruption(snapshotPromise);
      const snapshotRootfsStat = await raceInterruption(this.dependencies.lstat(snapshot.rootfsPath));
      if (
        snapshotRootfsStat.isSymbolicLink() ||
        !snapshotRootfsStat.isFile() ||
        snapshotRootfsStat.size !== verifiedRootfs.artifact.sizeBytes ||
        await raceInterruption(calculateSha256(snapshot.rootfsPath)) !== verifiedRootfs.artifact.sha256
      ) {
        throw new Error('Enclave rootfs snapshot does not match its attested artifact digest');
      }
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const artifacts: CloudHypervisorPreflightResult = {
        ...this.options.preflight,
        cloudHypervisorBinary: snapshot.cloudHypervisorBinary,
        virtiofsdBinary: snapshot.virtiofsdBinary,
        kernelPath: snapshot.kernelPath,
        rootfsPath: snapshot.rootfsPath,
        supervisorPath: snapshot.supervisorPath,
        artifactSnapshotDirectory: snapshot.directory,
        artifactDigests: {
          ...this.options.preflight.artifactDigests,
          rootfs: verifiedRootfs.artifact.sha256,
        },
      };
      const profile = createWorkloadProfile(plan, exportPlan, artifacts, policy);
      await raceInterruption(trackFilesystemWork(
        stageInvocationInputs(plan, role, policy, this.dependencies),
      ));
      const managerConfig = {
        ...this.options.config,
        cloudHypervisorBinary: artifacts.cloudHypervisorBinary,
      };
      manager = this.dependencies.createManager(
        managerConfig,
        this.options.workDir,
        profile,
        runId,
        artifacts,
        this.options.managerDependencies,
      );
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await raceInterruption(trackFilesystemWork(manager.start()));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await raceInterruption(trackFilesystemWork(manager.startInstance()));
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const executionResult = await raceInterruption(manager.execute({
        argv: [role === 'script'
          ? this.options.enclaveArtifacts.manifest.rootfs.script.entrypoint
          : this.options.enclaveArtifacts.manifest.rootfs.agent.entrypoint],
        cwd: '/',
        uid: 65534,
        gid: 65534,
        timeoutMs: plan.timeoutMs,
        env: role === 'agent' && policy ? agentEnvironment(policy, plan) : {},
      }));
      if (filesystemState.timedOut || executionResult.timedOut) {
        outcome = { outcome: 'timeout' };
      } else if (filesystemState.aborted || signal.aborted) {
        outcome = { outcome: 'cancelled' };
      } else if (executionResult.exitCode !== 0 || executionResult.signal !== null) {
        outcome = { outcome: 'executor-failure' };
      } else {
        await raceInterruption(stopManager());
        managerStopped = true;
        await raceInterruption(manager.completeCleanupRecord());
        if (filesystemState.timedOut || filesystemState.aborted || signal.aborted) {
          outcome = filesystemState.timedOut ? { outcome: 'timeout' } : { outcome: 'cancelled' };
        } else {
          const outputPath = filePath(filePath(plan.invocationHostDir, 'output'), OUTPUT_NAME);
          const maxBytes = role === 'agent'
            ? policy?.maxOutputBytes ?? HOST_EXECUTOR_MAX_RESULT_BYTES
            : HOST_EXECUTOR_MAX_RESULT_BYTES;
          const resultValue = await raceInterruption(readBoundedCloudHypervisorEnclaveResult(
            outputPath,
            plan.schema,
            maxBytes,
          ));
          outcome = resultValue === undefined
            ? { outcome: 'schema-failure' }
            : { outcome: 'success', result: resultValue };
        }
      }
    } catch {
      outcome = filesystemState.timedOut
        ? { outcome: 'timeout' }
        : filesystemState.aborted || signal.aborted
        ? { outcome: 'cancelled' }
        : { outcome: 'executor-failure' };
    } finally {
      signal.removeEventListener('abort', abortManager);
      clearTimeout(deadline);
      // Interrupted staging/startup can still create resources. Drain every
      // such operation before removing exports or reporting terminal.
      await Promise.allSettled([...pendingWork]);
      if (manager && stopPromise) {
        await stopPromise.catch(() => undefined);
        stopPromise = undefined;
      }
      if (manager && !managerStopped) {
        try {
          await stopManager();
          managerStopped = true;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (manager && managerStopped) {
        try {
          await manager.completeCleanupRecord();
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      }
      if (snapshot && (!manager || managerStopped)) {
        try {
          await resourceJournal?.verifySnapshot();
          await this.dependencies.removeArtifactSnapshot(snapshot.directory);
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      }
      if (!manager || managerStopped) {
        try {
          await cleanupInvocationFilesystem();
          await resourceJournal?.complete();
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      } else if (filesystemState.invocationDirectoryCreated && !filesystemState.mounted) {
        try {
          await resourceJournal?.verifyDirectory();
          await this.dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (cleanupError !== undefined) {
      this.closed = true;
      return { outcome: 'executor-failure', cleanupComplete: false };
    }
    return outcome;
  }
}
