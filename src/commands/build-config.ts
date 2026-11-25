import { WrapperConfig, LogLevel, UpstreamProxyConfig } from '../types';
import type { ParsedCliOptions } from './parsed-cli-options';
import { resolveApiCredentials } from './resolve-credentials';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { resolveSteeringBudget } from '../parsers/rate-limit-parsers';
import { logger } from '../logger';
import { resolveAgentHome } from '../agent-home';
import {
  CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
  CLOUD_HYPERVISOR_DEFAULT_BINARY,
  CLOUD_HYPERVISOR_DEFAULT_MOUNT_POLICY,
  CLOUD_HYPERVISOR_DEFAULT_MEMORY_MIB,
  CLOUD_HYPERVISOR_DEFAULT_VCPU_COUNT,
  CLOUD_HYPERVISOR_MOUNT_POLICIES,
  type CloudHypervisorMountPolicy,
  NVX_DEFAULT_MEMORY_MIB,
  NVX_DEFAULT_MEMORY_MAX_BYTES,
  NVX_DEFAULT_MOUNT_POLICY,
  NVX_DEFAULT_PIDS_MAX,
  NVX_MOUNT_POLICIES,
  type NvxMountPolicy,
} from '../types/runtime-options';

/**
 * Resolves the effective `legacySecurity` value from CLI options.
 *
 * Sources (in priority order):
 * 1. `--legacy-security` boolean flag (preferred)
 * 2. `--security-mode compat` (deprecated, maps to legacySecurity=true)
 */
function resolveLegacySecurity(options: ParsedCliOptions): boolean | undefined {
  // Preferred new flag takes precedence
  const legacySecurity = options.legacySecurity;
  if (legacySecurity !== undefined) {
    return legacySecurity || undefined;
  }

  // Handle deprecated --security-mode flag (only if --legacy-security not specified)
  const securityMode = options.securityMode;
  if (securityMode === 'compat') {
    logger.warn(
      '⚠️  --security-mode compat is deprecated. Use --legacy-security instead.',
    );
    return true;
  }
  if (securityMode === 'strict') {
    logger.warn(
      '⚠️  --security-mode is deprecated. Strict security is the default; remove the flag.',
    );
    return undefined;
  }

  return undefined;
}

/**
 * Resolves `--steering-budget` and its `--enable-token-steering` alias.
 * Calls `process.exit(1)` when the two are set to different values.
 */
function resolveSteeringBudgetOrExit(options: ParsedCliOptions): boolean {
  const result = resolveSteeringBudget(options);
  if (!result.valid) {
    logger.error(`❌ ${result.error}`);
    process.exit(1);
  }
  return result.value;
}

/**
 * Inputs required to assemble a {@link WrapperConfig}.
 *
 * All fields must already be parsed and validated by the caller.
 */
interface BuildConfigInputs {
  options: ParsedCliOptions;
  agentCommand: string;
  logLevel: LogLevel;
  allowedDomains: string[];
  sensitiveAllowedDomains?: string[];
  blockedDomains: string[];
  localhostDetected: boolean;
  additionalEnv: Record<string, string>;
  volumeMounts: string[] | undefined;
  upstreamProxy: UpstreamProxyConfig | undefined;
  dnsServers: string[];
  dnsServersExplicit?: boolean;
  dnsOverHttps: string | undefined;
  networkSubnet?: string;
  allowedUrls: string[] | undefined;
  memoryLimit: string | undefined;
  pidsLimit: number | undefined;
  agentImage: string | undefined;
  modelAliases: Record<string, string[]> | undefined;
  allowedModels: string[] | undefined;
  disallowedModels: string[] | undefined;
  maxAiCredits: number | undefined;
  modelMultipliers: Record<string, number> | undefined;
  defaultModelMultiplier: number | undefined;
  maxModelMultiplierCap?: number;
  maxRuns: number | undefined;
  maxPermissionDenied: number | undefined;
  maxCacheMisses: number | undefined;
  resolvedCopilotApiTarget: string | undefined;
  resolvedCopilotApiBasePath: string | undefined;
  dockerHostPathPrefix: string | undefined;
}

/**
 * Assembles a {@link WrapperConfig} from pre-parsed and pre-validated inputs.
 *
 * This function performs no validation — callers must validate before calling.
 * The supplied environment defaults to the host environment for CLI callers.
 */
export function buildConfig(
  inputs: BuildConfigInputs,
  env: NodeJS.ProcessEnv = process.env,
): WrapperConfig {
  const { options } = inputs;
  const chrootIdentity = buildChrootIdentity(options);
  const environment = buildEnvironmentAndVolumeConfig(inputs, env, chrootIdentity);
  const dind = buildDindConfig(options);
  const cloudHypervisor = buildCloudHypervisorConfig(options);
  const nvx = buildNvxConfig(options);
  const apiProxy = buildApiProxyConfig(inputs, env);

  return {
    agentCommand: inputs.agentCommand,
    logLevel: inputs.logLevel,
    keepContainers: options.keepContainers,
    tty: options.tty || false,
    buildLocal: options.buildLocal,
    skipPull: options.skipPull,
    images: options.images,
    agentImage: inputs.agentImage,
    imageRegistry: options.imageRegistry,
    imageTag: options.imageTag,
    memoryLimit: inputs.memoryLimit,
    pidsLimit: inputs.pidsLimit,
    awfDockerHost: options.dockerHost,
    dockerHostPathPrefix: inputs.dockerHostPathPrefix,
    containerRuntime: options.containerRuntime,
    runnerTopology: options.runnerTopology,
    sysrootImage: options.sysrootImage,
    chrootBinariesSourcePath: options.chrootBinariesSourcePath,
    chrootIdentity,
    dind,
    cloudHypervisor,
    enclaveDebugPublic: options.enclaveDebugPublic,
    nvx,
    ...environment,
    ...buildNetworkConfig(inputs),
    ...buildModelRoutingConfig(inputs),
    ...buildTokenObservabilityConfig(options, env),
    ...apiProxy,
    enclaves: normalizeEnclavesConfig(
      options.enclaves,
      { primaryRuntime: options.containerRuntime },
    ),
  };
}

function buildNetworkConfig(inputs: BuildConfigInputs) {
  const { options, allowedDomains, sensitiveAllowedDomains = [], blockedDomains } = inputs;
  return {
    allowedDomains,
    sensitiveAllowedDomains: sensitiveAllowedDomains.length > 0 ? sensitiveAllowedDomains : undefined,
    blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined,
    dnsServers: inputs.dnsServers,
    dnsServersExplicit: inputs.dnsServersExplicit,
    dnsOverHttps: inputs.dnsOverHttps,
    enableHostAccess: options.enableHostAccess,
    networkIsolation: options.networkIsolation,
    networkSubnet: inputs.networkSubnet,
    verifySbxEgress: options.verifySbxEgress,
    topologyAttach: options.topologyAttach,
    localhostDetected: inputs.localhostDetected,
    allowHostPorts: options.allowHostPorts,
    allowHostServicePorts: options.allowHostServicePorts,
    sslBump: options.sslBump,
    enableDind: options.enableDind,
    enableDlp: options.enableDlp,
    legacySecurity: resolveLegacySecurity(options),
    allowedUrls: inputs.allowedUrls,
    upstreamProxy: inputs.upstreamProxy,
  } satisfies Partial<WrapperConfig>;
}

function buildEnvironmentAndVolumeConfig(
  inputs: BuildConfigInputs,
  env: NodeJS.ProcessEnv,
  chrootIdentity: WrapperConfig['chrootIdentity'],
) {
  const { options, additionalEnv } = inputs;
  const homeDir = options.home === undefined ? undefined : resolveAgentHome({
    homeDir: options.home,
    containerRuntime: options.containerRuntime,
    runnerTopology: options.runnerTopology,
    chrootIdentity,
  }, env);
  return {
    workDir: options.workDir,
    homeDir,
    additionalEnv: Object.keys(additionalEnv).length > 0 ? additionalEnv : undefined,
    envAll: options.envAll,
    excludeEnv:
      options.excludeEnv && options.excludeEnv.length > 0
        ? options.excludeEnv
        : undefined,
    envFile: options.envFile,
    volumeMounts: inputs.volumeMounts,
    inputDirs: options.inputDir,
    filesystemAllowWrite: options.filesystemAllowWrite,
    containerWorkDir: options.containerWorkdir,
    proxyLogsDir: options.proxyLogsDir,
    auditDir: options.auditDir || env.AWF_AUDIT_DIR,
    sessionStateDir: options.sessionStateDir || env.AWF_SESSION_STATE_DIR,
    commandOutputCaptureDir: options.captureCommandOutput,
    commandOutputCaptureMaxBytes: options.captureCommandOutputMaxBytes === undefined
      ? undefined
      : Number(options.captureCommandOutputMaxBytes),
    runnerToolCachePath: options.runnerToolCachePath,
    diagnosticLogs: options.diagnosticLogs || false,
  } satisfies Partial<WrapperConfig>;
}

function buildModelRoutingConfig(inputs: BuildConfigInputs) {
  const { options } = inputs;
  return {
    modelFallback: options.modelFallback,
    fallbackModels: options.fallbackModels,
    experimentalModelRouting: options.experimentalModelRouting,
    modelRouting: options.modelRouting,
    requestedModel: options.requestedModel,
    modelAliases: inputs.modelAliases,
    allowedModels: inputs.allowedModels,
    disallowedModels: inputs.disallowedModels,
    maxAiCredits: inputs.maxAiCredits,
    defaultAiCreditsPricing: options.defaultAiCreditsPricing,
    modelPricingCatalog: options.modelPricingCatalog,
    modelCatalogue: options.modelCatalogue,
    modelMultipliers: inputs.modelMultipliers,
    defaultModelMultiplier: inputs.defaultModelMultiplier,
    maxModelMultiplierCap: inputs.maxModelMultiplierCap,
    maxRuns: inputs.maxRuns,
    maxPermissionDenied: inputs.maxPermissionDenied,
    maxCacheMisses: inputs.maxCacheMisses,
    enableTokenSteering: resolveSteeringBudgetOrExit(options),
  } satisfies Partial<WrapperConfig>;
}

function buildTokenObservabilityConfig(options: ParsedCliOptions, env: NodeJS.ProcessEnv) {
  return {
    debugTokens:
      options.debugTokens ?? (env.AWF_DEBUG_TOKENS === '1' ? true : undefined),
    tokenLogDir:
      options.tokenLogDir ?? (env.AWF_TOKEN_LOG_DIR?.trim() || undefined),
    captureBlockedRequests:
      options.captureBlockedRequests ??
      (env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS
        ? (env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS as 'summary' | 'redacted' | 'full')
        : undefined),
    maxCapturedBytes:
      options.maxCapturedBytes ??
      (env.AWF_MAX_BLOCKED_CAPTURE_BYTES
        ? Number(env.AWF_MAX_BLOCKED_CAPTURE_BYTES)
        : undefined),
  } satisfies Partial<WrapperConfig>;
}

function buildApiProxyConfig(inputs: BuildConfigInputs, env: NodeJS.ProcessEnv) {
  const { options } = inputs;
  return {
    enableApiProxy: options.enableApiProxy,
    apiProxyCaCert: options.apiProxyCaCert,
    copilotTokenBroker: options.copilotTokenBroker,
    anthropicAutoCache: options.anthropicAutoCache,
    anthropicCacheTailTtl: options.anthropicCacheTailTtl,
    claudeHostedWeb: options.claudeHostedWeb,
    codexHostedWeb: options.codexHostedWeb,
    apiProxyProviders: options.apiProxyProviders,
    ...resolveApiCredentials(options, {
      resolvedCopilotApiTarget: inputs.resolvedCopilotApiTarget,
      resolvedCopilotApiBasePath: inputs.resolvedCopilotApiBasePath,
      additionalEnv: inputs.additionalEnv,
      envFile: options.envFile,
    }, env),
    copilotByokExtraHeaders: options.copilotByokExtraHeaders,
    copilotByokExtraBodyFields: options.copilotByokExtraBodyFields,
    copilotByokSessionId: options.copilotByokSessionId,
    difcProxyHost: options.difcProxyHost,
    difcProxyCaCert: options.difcProxyCaCert,
    maxGithubApiPointsRest: options.maxGithubApiPointsRest === undefined
      ? undefined
      : Number(options.maxGithubApiPointsRest),
    maxGithubApiPointsGraphql: options.maxGithubApiPointsGraphql === undefined
      ? undefined
      : Number(options.maxGithubApiPointsGraphql),
    maxNumToolCalls: options.maxNumToolCalls === undefined
      ? undefined
      : Number(options.maxNumToolCalls),
  } satisfies Partial<WrapperConfig>;
}

function parsePositiveIntegerOption(
  value: unknown,
  optionName: string,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

/**
 * Builds the Cloud Hypervisor microVM runtime config (artifacts/digests
 * plus vcpu/memory/timeout settings). `--container-runtime cloud-hypervisor`
 * requires explicit
 * `--cloud-hypervisor-preview` opt-in and full artifact/digest
 * configuration, enforced by
 * `assertCloudHypervisorRuntimeCompatibility` in
 * `src/cloud-hypervisor/runtime-validation.ts`.
 */
function buildCloudHypervisorConfig(
  options: ParsedCliOptions,
): WrapperConfig['cloudHypervisor'] {
  const selected = options.containerRuntime === 'cloud-hypervisor';
  const configured = options.cloudHypervisorPreview === true
    || options.cloudHypervisorDevelopmentAllowUnattestedArtifacts === true
    || options.cloudHypervisorEnclaveDebugPublic === true
    || ([
      'cloudHypervisorMountPolicy',
      'cloudHypervisorBinary',
      'cloudHypervisorKernel',
      'cloudHypervisorRootfs',
      'cloudHypervisorSupervisor',
      'cloudHypervisorArtifactManifest',
      'cloudHypervisorArtifactManifestBundle',
      'cloudHypervisorArtifactReleaseTag',
      'cloudHypervisorVcpus',
      'cloudHypervisorMemoryMib',
      'cloudHypervisorScratchMib',
      'cloudHypervisorApiTimeoutMs',
      'cloudHypervisorBinarySha256',
      'cloudHypervisorVirtiofsdSha256',
      'cloudHypervisorKernelSha256',
      'cloudHypervisorRootfsSha256',
      'cloudHypervisorSupervisorSha256',
    ] as const).some((key) => options[key] !== undefined);
  if (!selected && !configured) return undefined;

  const sha256 = {
    cloudHypervisor: options.cloudHypervisorBinarySha256,
    virtiofsd: options.cloudHypervisorVirtiofsdSha256,
    kernel: options.cloudHypervisorKernelSha256,
    rootfs: options.cloudHypervisorRootfsSha256,
    supervisor: options.cloudHypervisorSupervisorSha256,
  };

  return {
    previewEnabled: options.cloudHypervisorPreview === true,
    mountPolicy: parseCloudHypervisorMountPolicy(options.cloudHypervisorMountPolicy),
    cloudHypervisorBinary:
      options.cloudHypervisorBinary ?? CLOUD_HYPERVISOR_DEFAULT_BINARY,
    kernelPath: options.cloudHypervisorKernel,
    rootfsPath: options.cloudHypervisorRootfs,
    supervisorPath: options.cloudHypervisorSupervisor,
    artifactManifestPath: options.cloudHypervisorArtifactManifest,
    artifactManifestBundlePath:
      options.cloudHypervisorArtifactManifestBundle,
    artifactReleaseTag: options.cloudHypervisorArtifactReleaseTag,
    developmentAllowUnattestedArtifacts:
      options.cloudHypervisorDevelopmentAllowUnattestedArtifacts === true,
    ...(options.cloudHypervisorEnclaveDebugPublic !== undefined
      ? { enclaveDebugPublic: options.cloudHypervisorEnclaveDebugPublic === true }
      : {}),
    vcpuCount: parsePositiveIntegerOption(
      options.cloudHypervisorVcpus,
      '--cloud-hypervisor-vcpus',
      CLOUD_HYPERVISOR_DEFAULT_VCPU_COUNT,
    ),
    memoryMib: parsePositiveIntegerOption(
      options.cloudHypervisorMemoryMib,
      '--cloud-hypervisor-memory-mib',
      CLOUD_HYPERVISOR_DEFAULT_MEMORY_MIB,
    ),
    ...(options.cloudHypervisorScratchMib !== undefined
      ? { scratchMib: parseCloudHypervisorScratchMib(options.cloudHypervisorScratchMib) }
      : {}),
    apiTimeoutMs: parsePositiveIntegerOption(
      options.cloudHypervisorApiTimeoutMs,
      '--cloud-hypervisor-api-timeout-ms',
      CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
    ),
    sha256: Object.values(sha256).some((value) => value !== undefined)
      ? sha256
      : undefined,
  };
}

function parseNvxMountPolicy(value: unknown): NvxMountPolicy {
  const policy = value ?? NVX_DEFAULT_MOUNT_POLICY;
  if (
    typeof policy !== 'string' ||
    !NVX_MOUNT_POLICIES.includes(policy as NvxMountPolicy)
  ) {
    throw new Error(
      '--nvx-mount-policy must be "workspace-only" or "workspace-and-tool-cache"',
    );
  }
  return policy as NvxMountPolicy;
}

function parseCloudHypervisorMountPolicy(value: unknown): CloudHypervisorMountPolicy {
  const policy = value ?? CLOUD_HYPERVISOR_DEFAULT_MOUNT_POLICY;
  if (
    typeof policy !== 'string' ||
    !CLOUD_HYPERVISOR_MOUNT_POLICIES.includes(policy as CloudHypervisorMountPolicy)
  ) {
    throw new Error(
      '--cloud-hypervisor-mount-policy must be "workspace-only" or "workspace-and-tool-cache"',
    );
  }
  return policy as CloudHypervisorMountPolicy;
}

function parseCloudHypervisorScratchMib(value: unknown): number {
  const parsed = parsePositiveIntegerOption(value, '--cloud-hypervisor-scratch-mib', 1);
  if (parsed > 0xffffffff) {
    throw new Error('--cloud-hypervisor-scratch-mib must be at most 4294967295');
  }
  return parsed;
}

/**
 * Builds the NVX preview one-shot microVM runtime config (artifacts plus
 * memory/pids/scratch settings). `--container-runtime nvx` requires
 * explicit `--nvx-preview` opt-in and full artifact configuration, enforced
 * by `assertNvxRuntimeCompatibility` in `src/nvx/runtime-validation.ts`.
 */
function buildNvxConfig(
  options: ParsedCliOptions,
): WrapperConfig['nvx'] {
  const selected = options.containerRuntime === 'nvx';
  const configured = options.nvxPreview === true
    || ([
      'nvxMountPolicy',
      'nvxLayer',
      'nvxArtifactManifest',
      'nvxArtifactManifestBundle',
      'nvxSignerWorkflow',
      'nvxOpenvmm',
      'nvxKernel',
      'nvxInitramfs',
      'nvxMemoryMib',
      'nvxMemoryMaxBytes',
      'nvxPidsMax',
      'nvxScratchBytes',
    ] as const).some((key) => options[key] !== undefined);
  if (!selected && !configured) return undefined;

  return {
    previewEnabled: options.nvxPreview === true,
    mountPolicy: parseNvxMountPolicy(options.nvxMountPolicy),
    layerPath: options.nvxLayer,
    artifactManifestPath: options.nvxArtifactManifest,
    artifactManifestBundlePath: options.nvxArtifactManifestBundle,
    signerWorkflow: options.nvxSignerWorkflow,
    openvmmPath: options.nvxOpenvmm,
    kernelPath: options.nvxKernel,
    initramfsPath: options.nvxInitramfs,
    memoryMib: parsePositiveIntegerOption(
      options.nvxMemoryMib,
      '--nvx-memory-mib',
      NVX_DEFAULT_MEMORY_MIB,
    ),
    memoryMaxBytes: parsePositiveIntegerOption(
      options.nvxMemoryMaxBytes,
      '--nvx-memory-max-bytes',
      NVX_DEFAULT_MEMORY_MAX_BYTES,
    ),
    pidsMax: parsePositiveIntegerOption(
      options.nvxPidsMax,
      '--nvx-pids-max',
      NVX_DEFAULT_PIDS_MAX,
    ),
    scratchBytes: options.nvxScratchBytes === undefined
      ? undefined
      : parseScratchBytesOption(options.nvxScratchBytes),
  };
}

function parseScratchBytesOption(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--nvx-scratch-bytes must be a positive integer');
  }
  return parsed;
}

function buildChrootIdentity(
  options: ParsedCliOptions
): WrapperConfig['chrootIdentity'] {
  const uid = parseOptionalIntegerOption(options.chrootIdentityUid);
  const gid = parseOptionalIntegerOption(options.chrootIdentityGid);

  if (
    options.chrootIdentityHome === undefined
    && options.chrootIdentityUser === undefined
    && uid === undefined
    && gid === undefined
  ) {
    return undefined;
  }

  return {
    home: options.chrootIdentityHome,
    user: options.chrootIdentityUser,
    uid,
    gid,
  };
}

function buildDindConfig(options: ParsedCliOptions): WrapperConfig['dind'] {
  const stageEngineBinary = (
    options.dindStageEngineBinaryPath !== undefined
    || options.dindStageEngineBinaryTargetPath !== undefined
  )
    ? {
      path: options.dindStageEngineBinaryPath,
      targetPath: options.dindStageEngineBinaryTargetPath,
    }
    : undefined;

  if (
    options.dindPreStageDirs === undefined
    && options.dindWorkDir === undefined
    && options.dindStagingImage === undefined
    && stageEngineBinary === undefined
  ) {
    return undefined;
  }

  return {
    preStageDirs: options.dindPreStageDirs,
    workDir: options.dindWorkDir,
    stagingImage: options.dindStagingImage,
    stageEngineBinary,
  };
}

function parseOptionalIntegerOption(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}
