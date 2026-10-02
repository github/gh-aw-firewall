import { randomBytes } from 'crypto';
import { constants, promises as fs } from 'fs';
import execa from 'execa';
import * as os from 'os';
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
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import type { EnclaveAgentProfile } from '../types/enclave-options';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
  CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
} from './artifact-manifest';
import {
  createArtifactSnapshot,
  type CloudHypervisorArtifactSnapshot,
  type CloudHypervisorArtifactSnapshotSources,
} from './artifact-snapshot';
import {
  assertTrustedAncestorChain,
  assertTrustedHostTool,
  assertTrustedRegularFile,
  calculateSha256,
  resolveTrustedOperatorUid,
} from './artifact-trust';
import {
  enclaveRootfsArtifactForRole,
  parseCloudHypervisorEnclaveArtifactManifest,
  type CloudHypervisorEnclaveArtifactManifest,
  type CloudHypervisorEnclaveRootfsArtifact,
  type CloudHypervisorEnclaveRole,
} from './enclave-artifact-manifest';
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
import type {
  CloudHypervisorHostToolPaths,
  CloudHypervisorPreflightResult,
} from './preflight';
import { copySparseFileWithRsync, runCloudHypervisorPreflight } from './preflight';
import {
  CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES,
  createAgentEnclaveCloudHypervisorProfile,
  createScriptEnclaveCloudHypervisorProfile,
  type CloudHypervisorWorkloadProfile,
} from './workload-profile';

const GITHUB_PROFILE = 'issues-read-v1';
const GITHUB_ENDPOINT = `http://${ENCLAVE_AGENT_GITHUB_MCP_IP}:${ENCLAVE_GITHUB_MCP_PORT}/mcp/github`;
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
  ) => Promise<CloudHypervisorArtifactSnapshot>;
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

const defaultDependencies: HostEnclaveExecutorDependencies = {
  createArtifactSnapshot,
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
  mountTmpfs: async (directory, sizeBytes, uid, gid, tools) => {
    const mountOptions =
      `size=${sizeBytes},mode=0700,uid=${uid},gid=${gid},nosuid,nodev,noexec`;
    const result = await execa(tools.mount, [
      '-t', 'tmpfs',
      '-o', mountOptions,
      'awf-enclave-invocation',
      directory,
    ], { reject: false, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to mount bounded enclave invocation storage: ${result.stderr.trim()}`);
    }
  },
  unmount: async (directory, tools) => {
    const result = await execa(tools.umount, [directory], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to unmount enclave invocation storage: ${result.stderr.trim()}`);
    }
  },
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

async function verifyAttestation(
  executable: string,
  subject: string,
  bundle: string,
): Promise<void> {
  // The executable is resolved and ownership-verified before this helper is called.
  // eslint-disable-next-line local/no-unsafe-execa
  const result = await execa(executable, [
    'attestation', 'verify', subject,
    '--repo', CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
    '--bundle', bundle,
    '--signer-workflow', CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
    '--deny-self-hosted-runners',
  ], {
    reject: false,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Enclave artifact attestation verification failed: ${result.stderr.trim()}`);
  }
}

async function readTrustedArtifactBytes(
  filePathValue: string,
  uid: number,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(
    filePathValue,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maxBytes ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== 0 && stat.uid !== uid)
    ) {
      throw new Error('Trusted enclave artifact has invalid file metadata');
    }
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (total <= maxBytes) {
      const length = Math.min(chunk.length, maxBytes + 1 - total);
      const { bytesRead } = await handle.read(chunk, 0, length, total);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total < 1 || total > maxBytes) {
      throw new Error('Trusted enclave artifact has invalid content size');
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/**
 * Verifies the release-pinned enclave artifact set before any invocation is
 * admitted: trusted ownership/modes, closed manifest, content digests, and
 * GitHub attestations for the manifest and both role-specific root filesystems.
 */
export async function preflightCloudHypervisorEnclaveArtifacts(
  options: CloudHypervisorEnclaveArtifactPreflightOptions,
): Promise<VerifiedCloudHypervisorEnclaveArtifacts> {
  const uid = resolveTrustedOperatorUid();
  await assertTrustedHostTool('GitHub CLI', options.attestationToolPath);
  const manifestDir = path.dirname(options.manifestPath);
  const expectedBundle = filePath(manifestDir, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
  if (options.manifestBundlePath !== expectedBundle) {
    throw new Error('Enclave artifact manifest bundle must use its fixed release filename');
  }
  await assertTrustedRegularFile('enclave artifact manifest', options.manifestPath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  });
  await assertTrustedRegularFile('enclave artifact manifest bundle', options.manifestBundlePath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  });
  const manifestBytes = await readTrustedArtifactBytes(options.manifestPath, uid, 1024 * 1024);
  const bundleBytes = await readTrustedArtifactBytes(options.manifestBundlePath, uid, 8 * 1024 * 1024);
  const verificationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-attestation-'));
  try {
    const verifiedManifestPath = path.join(verificationDirectory, 'manifest.json');
    const verifiedBundlePath = path.join(
      verificationDirectory,
      'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
    );
    await fs.writeFile(verifiedManifestPath, manifestBytes, { flag: 'wx', mode: 0o400 });
    await fs.writeFile(verifiedBundlePath, bundleBytes, { flag: 'wx', mode: 0o400 });
    const manifest = parseCloudHypervisorEnclaveArtifactManifest(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
      options.releaseTag,
    );
    await verifyAttestation(options.attestationToolPath, verifiedManifestPath, verifiedBundlePath);

    const rootfs: Record<CloudHypervisorEnclaveRole, {
      path: string;
      artifact: CloudHypervisorEnclaveRootfsArtifact;
    }> = {
      script: { path: '', artifact: manifest.rootfs.script },
      agent: { path: '', artifact: manifest.rootfs.agent },
    };
    for (const role of ['script', 'agent'] as const) {
      const artifact = enclaveRootfsArtifactForRole(manifest, role);
      const expectedRootfs = filePath(manifestDir, artifact.file);
      const provenance = filePath(manifestDir, `enclave-${role}-rootfs.provenance.sigstore.jsonl`);
      const sbom = filePath(manifestDir, artifact.sbom.file);
      const configuredPath = role === 'script'
        ? options.scriptRootfsPath
        : options.agentRootfsPath;
      if (configuredPath !== expectedRootfs) {
        throw new Error(`Configured ${role} enclave rootfs does not match the trusted manifest path`);
      }
      for (const [label, file] of [
        [`${role} enclave rootfs`, expectedRootfs],
        [`${role} enclave rootfs provenance`, provenance],
        [`${role} enclave rootfs SBOM`, sbom],
      ] as const) {
        await assertTrustedRegularFile(label, file, constants.R_OK, {
          uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
        });
      }
      const rootfsStat = await fs.lstat(expectedRootfs);
      if ((await fs.lstat(provenance)).size > 8 * 1024 * 1024 ||
        (await fs.lstat(sbom)).size > 16 * 1024 * 1024) {
        throw new Error(`${role} enclave rootfs provenance or SBOM exceeds its size limit`);
      }
      if (rootfsStat.size !== artifact.sizeBytes || await calculateSha256(expectedRootfs) !== artifact.sha256) {
        throw new Error(`${role} enclave rootfs does not match its trusted manifest digest and size`);
      }
      if (await calculateSha256(sbom) !== artifact.sbom.sha256) {
        throw new Error(`${role} enclave rootfs SBOM does not match its trusted manifest digest`);
      }
      await verifyAttestation(options.attestationToolPath, expectedRootfs, provenance);
      if (role === 'script') rootfs.script = { path: expectedRootfs, artifact };
      else rootfs.agent = { path: expectedRootfs, artifact };
    }
    return Object.freeze({
      manifest,
      manifestPath: options.manifestPath,
      manifestBundlePath: options.manifestBundlePath,
      rootfs: Object.freeze(rootfs),
    });
  } finally {
    await fs.rm(verificationDirectory, { recursive: true, force: true });
  }
}

async function resolveTrustedAttestationTool(environment: NodeJS.ProcessEnv): Promise<string> {
  let lastError: unknown;
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, 'gh');
    try {
      await assertTrustedHostTool('GitHub CLI', candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `A trusted GitHub CLI is required to verify enclave artifact attestations: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? 'not found')
    }`,
  );
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

async function prepareInvocationFilesystem(
  runState: HostExecutorRunState,
  plan: HostExecutorInvocationPlan,
  role: CloudHypervisorEnclaveRole,
  dependencies: HostEnclaveExecutorDependencies,
  tools: CloudHypervisorHostToolPaths,
  onDirectoryCreated: () => void,
  onMounted: () => void,
): Promise<void> {
  const invocationParent = path.dirname(plan.invocationHostDir);
  const invocationRoot = runState.invocationsDir;
  if (
    invocationParent !== path.join(invocationRoot, plan.entryId) ||
    path.dirname(invocationParent) !== invocationRoot
  ) {
    throw new Error('Host executor invocation directory is outside the trusted run root');
  }
  const identity = dependencies.resolveIdentity();
  const trustDependencies = {
    uid: identity.uid,
    access: fs.access,
    lstat: dependencies.lstat,
    sha256: calculateSha256,
  };
  await assertTrustedAncestorChain(
    'host executor invocation storage',
    invocationRoot,
    trustDependencies,
  );
  await assertTrustedDirectory(invocationRoot, identity.uid, dependencies);
  try {
    await dependencies.lstat(invocationParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await dependencies.mkdir(invocationParent, { mode: 0o700 });
  }
  await assertTrustedDirectory(invocationParent, identity.uid, dependencies);
  await dependencies.mkdir(plan.invocationHostDir, { mode: 0o700 });
  onDirectoryCreated();
  const invocationStat = await dependencies.lstat(plan.invocationHostDir);
  if (invocationStat.isSymbolicLink() || !invocationStat.isDirectory()) {
    throw new Error('Host executor invocation directory must be a new real directory');
  }
  const resourceProfile = role === 'script'
    ? CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script
    : CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent;
  await dependencies.mountTmpfs(
    plan.invocationHostDir,
    resourceProfile.writableStorageBytes,
    identity.uid,
    identity.gid,
    tools,
  );
  onMounted();
  for (const name of ['request', 'output', 'runtime']) {
    const directory = filePath(plan.invocationHostDir, name);
    await dependencies.mkdir(directory, { mode: 0o700 });
    await dependencies.chown(directory, identity.uid, identity.gid);
  }

  if (role === 'agent') {
    for (const name of ['session-handoff', 'session-state']) {
      const directory = filePath(plan.invocationHostDir, name);
      await dependencies.mkdir(directory, { mode: 0o700 });
      await dependencies.chown(directory, identity.uid, identity.gid);
    }
  }
}

async function assertTrustedDirectory(
  directory: string,
  operatorUid: number,
  dependencies: HostEnclaveExecutorDependencies,
): Promise<void> {
  const stat = await dependencies.lstat(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.uid !== 0 && stat.uid !== operatorUid) ||
    await dependencies.realpath(directory) !== directory
  ) {
    throw new Error('Host executor invocation directories must be trusted private directories');
  }
}

async function writePrivateFile(
  filePathValue: string,
  contents: string,
  uid: number,
  gid: number,
  mode: number,
  dependencies: HostEnclaveExecutorDependencies,
): Promise<void> {
  await dependencies.writeFile(filePathValue, contents, { encoding: 'utf8', mode, flag: 'wx' });
  await dependencies.chown(filePathValue, uid, gid);
  await dependencies.chmod(filePathValue, mode);
}

async function stageInvocationInputs(
  plan: HostExecutorInvocationPlan,
  role: CloudHypervisorEnclaveRole,
  policy: HostExecutorAgentPolicy | undefined,
  dependencies: HostEnclaveExecutorDependencies,
): Promise<void> {
  const identity = dependencies.resolveIdentity();
  const requestDir = filePath(plan.invocationHostDir, 'request');
  if (role === 'script') {
    await writePrivateFile(
      filePath(requestDir, 'query-script.py'),
      plan.payload,
      identity.uid,
      identity.gid,
      0o400,
      dependencies,
    );
    return;
  }
  if (!policy) throw new Error('Trusted agent policy is required for an agent enclave');
  await writePrivateFile(filePath(requestDir, 'task.txt'), plan.payload, identity.uid, identity.gid, 0o400, dependencies);
  await writePrivateFile(
    filePath(requestDir, 'schema.json'),
    JSON.stringify(plan.schema),
    identity.uid,
    identity.gid,
    0o400,
    dependencies,
  );
  const runtimeDir = filePath(plan.invocationHostDir, 'runtime');
  const sessionFile = filePath(runtimeDir, 'session.jsonl');
  await writePrivateFile(sessionFile, '', identity.uid, identity.gid, 0o600, dependencies);
  if (policy.githubAgentId !== undefined && policy.githubBearer !== undefined) {
    const handoffDir = filePath(plan.invocationHostDir, 'session-handoff');
    await writePrivateFile(
      filePath(handoffDir, 'github-agent-id'),
      `${policy.githubAgentId}\n`,
      identity.uid,
      identity.gid,
      0o400,
      dependencies,
    );
    await writePrivateFile(
      filePath(handoffDir, 'github-bearer'),
      `${policy.githubBearer}\n`,
      identity.uid,
      identity.gid,
      0o400,
      dependencies,
    );
  }
}

function agentEnvironment(
  policy: HostExecutorAgentPolicy,
  plan: HostExecutorInvocationPlan,
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/agent/home',
    COPILOT_HOME: '/agent/copilot',
    COPILOT_OFFLINE: 'true',
    COPILOT_GITHUB_TOKEN: '******',
    COPILOT_TOKEN: '******',
    COPILOT_API_URL: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    COPILOT_PROVIDER_BASE_URL: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    COPILOT_MODEL: policy.model,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
    AWF_ENCLAVE_AGENT_PROFILE: policy.profile,
    AWF_ENCLAVE_AGENT_MODEL: policy.model,
    AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: String(policy.maxOutputBytes),
    AWF_ENCLAVE_AGENT_DEADLINE_SECONDS: String(Math.max(1, Math.floor(plan.timeoutMs / 1000))),
    AWF_ENCLAVE_AGENT_API_ENDPOINT: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    AWF_ENCLAVE_AGENT_GITHUB_ENABLED: String(policy.githubAgentId !== undefined),
    ...(policy.githubAgentId !== undefined ? {
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: GITHUB_PROFILE,
      AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: GITHUB_ENDPOINT,
    } : {}),
    ...(policy.maxModelRequests !== undefined
      ? { AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: String(policy.maxModelRequests) }
      : {}),
    ...(policy.maxModelTokens !== undefined
      ? { AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: String(policy.maxModelTokens) }
      : {}),
  });
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
  const guest: Omit<CloudHypervisorManagerGuestConfig, 'exports' | 'workspaceMount'> = {
    supervisorBinaryPath: artifacts.supervisorPath,
    supervisorSha256: artifacts.artifactDigests.supervisor,
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
    const runId = randomBytes(16).toString('hex');
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
    const abortManager = (): void => {
      filesystemState.aborted = true;
      void manager?.cancel('host executor cancelled').catch(() => undefined);
      // Stopping concurrently with startup can miss resources created after stop returns.
    };
    signal.addEventListener('abort', abortManager, { once: true });
    const deadline = setTimeout(() => {
      filesystemState.timedOut = true;
      abortManager();
    }, plan.timeoutMs);
    try {
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await prepareInvocationFilesystem(
        this.options.runState,
        plan,
        role,
        this.dependencies,
        this.options.preflight.tools,
        () => { filesystemState.invocationDirectoryCreated = true; },
        () => { filesystemState.mounted = true; },
      );
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const exportPlan = await resolveCloudHypervisorEnclaveExportPlan(this.options.runState, plan);
      snapshot = await this.dependencies.createArtifactSnapshot({
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
      ));
      const snapshotRootfsStat = await this.dependencies.lstat(snapshot.rootfsPath);
      if (
        snapshotRootfsStat.isSymbolicLink() ||
        !snapshotRootfsStat.isFile() ||
        snapshotRootfsStat.size !== verifiedRootfs.artifact.sizeBytes ||
        await calculateSha256(snapshot.rootfsPath) !== verifiedRootfs.artifact.sha256
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
      await stageInvocationInputs(plan, role, policy, this.dependencies);
      manager = this.dependencies.createManager(
        this.options.config,
        this.options.workDir,
        profile,
        runId,
        artifacts,
        this.options.managerDependencies,
      );
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await manager.start();
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      await manager.startInstance();
      if (filesystemState.aborted) throw new Error('Host executor invocation was cancelled');
      const executionResult = await manager.execute({
        argv: [role === 'script'
          ? this.options.enclaveArtifacts.manifest.rootfs.script.entrypoint
          : this.options.enclaveArtifacts.manifest.rootfs.agent.entrypoint],
        cwd: '/',
        uid: 65534,
        gid: 65534,
        timeoutMs: plan.timeoutMs,
        env: role === 'agent' && policy ? agentEnvironment(policy, plan) : {},
      });
      if (filesystemState.timedOut || executionResult.timedOut) {
        outcome = { outcome: 'timeout' };
      } else if (filesystemState.aborted || signal.aborted) {
        outcome = { outcome: 'cancelled' };
      } else if (executionResult.exitCode !== 0 || executionResult.signal !== null) {
        outcome = { outcome: 'executor-failure' };
      } else {
        await stopManager();
        managerStopped = true;
        await manager.completeCleanupRecord();
        if (filesystemState.timedOut || filesystemState.aborted || signal.aborted) {
          outcome = filesystemState.timedOut ? { outcome: 'timeout' } : { outcome: 'cancelled' };
        } else {
          const outputPath = filePath(filePath(plan.invocationHostDir, 'output'), OUTPUT_NAME);
          const maxBytes = role === 'agent'
            ? policy?.maxOutputBytes ?? HOST_EXECUTOR_MAX_RESULT_BYTES
            : HOST_EXECUTOR_MAX_RESULT_BYTES;
          const resultValue = await readBoundedCloudHypervisorEnclaveResult(
            outputPath,
            plan.schema,
            maxBytes,
          );
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
          await this.dependencies.removeArtifactSnapshot(snapshot.directory);
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      }
      if (filesystemState.mounted && (!manager || managerStopped)) {
        try {
          await this.dependencies.unmount(plan.invocationHostDir, this.options.preflight.tools);
          await this.dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
        } catch (error) {
          cleanupError = cleanupError
            ? new Error(`${String(cleanupError)}; ${String(error)}`)
            : error;
        }
      } else if (filesystemState.invocationDirectoryCreated && !filesystemState.mounted) {
        try {
          await this.dependencies.rm(plan.invocationHostDir, { recursive: true, force: true });
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (cleanupError !== undefined) return { outcome: 'executor-failure' };
    return outcome;
  }
}
