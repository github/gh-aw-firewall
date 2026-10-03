import { promises as fs } from 'fs';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';
import type { HostExecutorResourceJournal } from '../enclave/host-executor-journal';
import type { EnclaveAgentProfile } from '../types/enclave-options';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type {
  CloudHypervisorEnclaveArtifactManifest,
  CloudHypervisorEnclaveRootfsArtifact,
  CloudHypervisorEnclaveRole,
} from './enclave-artifact-manifest';
import type {
  CloudHypervisorArtifactSnapshot,
  CloudHypervisorArtifactSnapshotSources,
} from './artifact-snapshot';
import type { CloudHypervisorManagerDependencies } from './manager-types';
import type { CloudHypervisorHostToolPaths, CloudHypervisorPreflightResult } from './preflight';
import type { assertBoundedEnclaveStorage } from './enclave-storage';
import type { CloudHypervisorWorkloadProfile } from './workload-profile';

export interface VerifiedCloudHypervisorEnclaveArtifacts {
  readonly manifest: CloudHypervisorEnclaveArtifactManifest;
  readonly manifestPath: string;
  readonly manifestBundlePath: string;
  readonly rootfs: Readonly<Record<CloudHypervisorEnclaveRole, {
    readonly path: string;
    readonly artifact: CloudHypervisorEnclaveRootfsArtifact;
  }>>;
}

export interface CloudHypervisorEnclaveArtifactPreflightOptions {
  readonly releaseTag: string;
  readonly manifestPath: string;
  readonly manifestBundlePath: string;
  readonly scriptRootfsPath: string;
  readonly agentRootfsPath: string;
  readonly attestationToolPath: string;
}

export interface HostExecutorAgentPolicy {
  readonly model: string;
  readonly profile: EnclaveAgentProfile;
  readonly maxOutputBytes: number;
  readonly maxModelRequests?: number;
  readonly maxModelTokens?: number;
  readonly githubAgentId?: string;
  readonly githubBearer?: string;
}

export interface HostEnclaveExecutorManager {
  start(): Promise<unknown>;
  startInstance(): Promise<void>;
  execute(request: {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly uid: number;
    readonly gid: number;
    readonly timeoutMs: number;
  }): Promise<{ readonly exitCode: number; readonly signal: string | null; readonly timedOut: boolean }>;
  cancel(reason?: string): Promise<void>;
  stop(): Promise<void>;
  completeCleanupRecord(): Promise<void>;
}

export interface HostEnclaveExecutorDependencies {
  readonly createArtifactSnapshot: (
    sources: CloudHypervisorArtifactSnapshotSources,
    copySparseFile: (source: string, destination: string) => Promise<void>,
    onDirectoryCreated?: (directory: string) => Promise<void>,
  ) => Promise<CloudHypervisorArtifactSnapshot>;
  readonly createResourceJournal: (
    run: HostExecutorRunState,
    plan: HostExecutorInvocationPlan,
    vmRunId: string,
  ) => Promise<Pick<HostExecutorResourceJournal,
    'captureDirectory' | 'captureMount' | 'prepareSnapshot' | 'captureSnapshot' | 'verifyMount' | 'verifyDirectory' |
    'verifySnapshot' | 'complete'>>;
  readonly copySparseFile: (rsyncBinaryPath: string, source: string, destination: string) => Promise<void>;
  readonly removeArtifactSnapshot: (directory: string) => Promise<void>;
  readonly createManager: (
    config: CloudHypervisorOptions,
    workDir: string,
    profile: CloudHypervisorWorkloadProfile,
    runId: string,
    artifacts: CloudHypervisorPreflightResult,
    managerDependencies?: CloudHypervisorManagerDependencies,
  ) => HostEnclaveExecutorManager;
  readonly mountTmpfs: (
    directory: string,
    sizeBytes: number,
    uid: number,
    gid: number,
    tools: CloudHypervisorHostToolPaths,
  ) => Promise<void>;
  readonly unmount: (directory: string, tools: CloudHypervisorHostToolPaths) => Promise<void>;
  readonly verifyStorage: typeof assertBoundedEnclaveStorage;
  readonly mkdir: typeof fs.mkdir;
  readonly realpath: typeof fs.realpath;
  readonly lstat: typeof fs.lstat;
  readonly writeFile: typeof fs.writeFile;
  readonly chmod: typeof fs.chmod;
  readonly chown: typeof fs.chown;
  readonly rm: typeof fs.rm;
  readonly resolveIdentity: () => { uid: number; gid: number };
}

export interface CreateCloudHypervisorHostEnclaveExecutorOptions {
  readonly runState: HostExecutorRunState;
  readonly config: CloudHypervisorOptions;
  readonly workDir: string;
  readonly agentPolicies?: Readonly<Record<string, HostExecutorAgentPolicy>>;
  readonly managerDependencies?: CloudHypervisorManagerDependencies;
  readonly environment?: NodeJS.ProcessEnv;
}
