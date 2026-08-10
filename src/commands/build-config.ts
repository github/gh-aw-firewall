import { WrapperConfig, LogLevel, UpstreamProxyConfig } from '../types';
import type { AwfFileConfig } from '../config-file';
import { resolveApiCredentials } from './resolve-credentials';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { logger } from '../logger';
import {
  FIRECRACKER_DEFAULT_API_TIMEOUT_MS,
  FIRECRACKER_DEFAULT_BINARY,
  FIRECRACKER_DEFAULT_JAILER_BINARY,
  FIRECRACKER_DEFAULT_MEMORY_MIB,
  FIRECRACKER_DEFAULT_VCPU_COUNT,
  CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
  CLOUD_HYPERVISOR_DEFAULT_BINARY,
  CLOUD_HYPERVISOR_DEFAULT_MEMORY_MIB,
  CLOUD_HYPERVISOR_DEFAULT_VCPU_COUNT,
} from '../types/runtime-options';

/**
 * Resolves the effective `legacySecurity` value from CLI options.
 *
 * Sources (in priority order):
 * 1. `--legacy-security` boolean flag (preferred)
 * 2. `--security-mode compat` (deprecated, maps to legacySecurity=true)
 */
function resolveLegacySecurity(options: Record<string, unknown>): boolean | undefined {
  // Preferred new flag takes precedence
  const legacySecurity = options.legacySecurity as boolean | undefined;
  if (legacySecurity !== undefined) {
    return legacySecurity || undefined;
  }

  // Handle deprecated --security-mode flag (only if --legacy-security not specified)
  const securityMode = options.securityMode as string | undefined;
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
 * Inputs required to assemble a {@link WrapperConfig}.
 *
 * All fields must already be parsed and validated by the caller.
 */
interface BuildConfigInputs {
  options: Record<string, unknown>;
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
  allowedUrls: string[] | undefined;
  memoryLimit: string | undefined;
  pidsLimit: number | undefined;
  agentImage: string | undefined;
  modelAliases: Record<string, string[]> | undefined;
  allowedModels: string[] | undefined;
  disallowedModels: string[] | undefined;
  maxEffectiveTokens: number | undefined;
  maxAiCredits: number | undefined;
  effectiveTokenModelMultipliers: Record<string, number> | undefined;
  effectiveTokenDefaultModelMultiplier: number | undefined;
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
 */
export function buildConfig(inputs: BuildConfigInputs): WrapperConfig {
  const {
    options,
    agentCommand,
    logLevel,
    allowedDomains,
    sensitiveAllowedDomains = [],
    blockedDomains,
    localhostDetected,
    additionalEnv,
    volumeMounts,
    upstreamProxy,
    dnsServers,
    dnsServersExplicit,
    dnsOverHttps,
    allowedUrls,
    memoryLimit,
    pidsLimit,
    agentImage,
    modelAliases,
    allowedModels,
    disallowedModels,
    maxEffectiveTokens,
    maxAiCredits,
    effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier,
    maxModelMultiplierCap,
    maxRuns,
    maxPermissionDenied,
    maxCacheMisses,
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
    dockerHostPathPrefix,
  } = inputs;

  const chrootIdentity = buildChrootIdentity(options);
  const dind = buildDindConfig(options);
  const firecracker = buildFirecrackerConfig(options);
  const cloudHypervisor = buildCloudHypervisorConfig(options);
  const apiCredentials = resolveApiCredentials(options, {
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
  });

  return {
    allowedDomains,
    sensitiveAllowedDomains: sensitiveAllowedDomains.length > 0 ? sensitiveAllowedDomains : undefined,
    blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined,
    agentCommand,
    logLevel,
    keepContainers: options.keepContainers as boolean,
    tty: (options.tty as boolean) || false,
    workDir: options.workDir as string,
    buildLocal: options.buildLocal as boolean,
    skipPull: options.skipPull as boolean,
    agentImage,
    imageRegistry: options.imageRegistry as string,
    imageTag: options.imageTag as string,
    additionalEnv: Object.keys(additionalEnv).length > 0 ? additionalEnv : undefined,
    envAll: options.envAll as boolean,
    excludeEnv:
      options.excludeEnv && (options.excludeEnv as string[]).length > 0
        ? (options.excludeEnv as string[])
        : undefined,
    envFile: options.envFile as string | undefined,
    volumeMounts,
    containerWorkDir: options.containerWorkdir as string | undefined,
    dnsServers,
    dnsServersExplicit,
    dnsOverHttps,
    memoryLimit,
    pidsLimit,
    proxyLogsDir: options.proxyLogsDir as string | undefined,
    auditDir: (options.auditDir as string | undefined) || process.env.AWF_AUDIT_DIR,
    sessionStateDir:
      (options.sessionStateDir as string | undefined) || process.env.AWF_SESSION_STATE_DIR,
    runnerToolCachePath: options.runnerToolCachePath as string | undefined,
    enableHostAccess: options.enableHostAccess as boolean,
    networkIsolation: options.networkIsolation as boolean | undefined,
    topologyAttach: options.topologyAttach as string[] | undefined,
    localhostDetected,
    allowHostPorts: options.allowHostPorts as string | undefined,
    allowHostServicePorts: options.allowHostServicePorts as string | undefined,
    sslBump: options.sslBump as boolean,
    enableDind: options.enableDind as boolean,
    enableDlp: options.enableDlp as boolean,
    legacySecurity: resolveLegacySecurity(options),
    allowedUrls,
    enableApiProxy: options.enableApiProxy as boolean | undefined,
    modelFallback:
      options.modelFallback as { enabled?: boolean; strategy?: 'middle_power' } | undefined,
    requestedModel: options.requestedModel as string | undefined,
    anthropicAutoCache: options.anthropicAutoCache as boolean,
    anthropicCacheTailTtl: options.anthropicCacheTailTtl as '5m' | '1h' | undefined,
    modelAliases,
    allowedModels,
    disallowedModels,
    maxEffectiveTokens,
    maxAiCredits,
    defaultAiCreditsPricing: options.defaultAiCreditsPricing as WrapperConfig['defaultAiCreditsPricing'],
    apiProxyProviders: options.apiProxyProviders as WrapperConfig['apiProxyProviders'],
    effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier,
    maxModelMultiplierCap,
    maxRuns,
    maxPermissionDenied,
    maxCacheMisses,
    enableTokenSteering: options.enableTokenSteering as boolean,
    debugTokens:
      (options.debugTokens as boolean | undefined) ??
      (process.env.AWF_DEBUG_TOKENS === '1' ? true : undefined),
    tokenLogDir:
      (options.tokenLogDir as string | undefined) ??
      (process.env.AWF_TOKEN_LOG_DIR?.trim() || undefined),
    captureBlockedRequests:
      (options.captureBlockedRequests as boolean | 'summary' | 'redacted' | 'full' | undefined) ??
      (process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS
        ? (process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS as 'summary' | 'redacted' | 'full')
        : undefined),
    maxCapturedBytes:
      (options.maxCapturedBytes as number | undefined) ??
      (process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES
        ? Number(process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES)
        : undefined),
    ...apiCredentials,
    copilotByokExtraHeaders: options.copilotByokExtraHeaders as Record<string, string> | undefined,
    copilotByokExtraBodyFields: options.copilotByokExtraBodyFields as Record<string, string> | undefined,
    copilotByokSessionId: options.copilotByokSessionId as string | undefined,
    difcProxyHost: options.difcProxyHost as string | undefined,
    difcProxyCaCert: options.difcProxyCaCert as string | undefined,
    diagnosticLogs: (options.diagnosticLogs as boolean) || false,
    awfDockerHost: options.dockerHost as string | undefined,
    upstreamProxy,
    dockerHostPathPrefix,
    containerRuntime: options.containerRuntime as string | undefined,
    runnerTopology: options.runnerTopology as 'standard' | 'arc-dind' | undefined,
    sysrootImage: options.sysrootImage as string | undefined,
    chrootBinariesSourcePath: options.chrootBinariesSourcePath as string | undefined,
    chrootIdentity,
    dind,
    firecracker,
    cloudHypervisor,
    enclaves: normalizeEnclavesConfig(
      options.enclaves as AwfFileConfig['enclaves'] | undefined,
    ),
  };
}

function buildFirecrackerConfig(
  options: Record<string, unknown>,
): WrapperConfig['firecracker'] {
  const selected = options.containerRuntime === 'firecracker';
  const configured = options.firecrackerPreview === true
    || [
      'firecrackerBinary',
      'firecrackerJailerBinary',
      'firecrackerKernel',
      'firecrackerRootfs',
      'firecrackerSupervisor',
      'firecrackerVcpus',
      'firecrackerMemoryMib',
      'firecrackerApiTimeoutMs',
      'firecrackerBinarySha256',
      'firecrackerJailerSha256',
      'firecrackerKernelSha256',
      'firecrackerRootfsSha256',
      'firecrackerSupervisorSha256',
    ].some((key) => options[key] !== undefined);
  if (!selected && !configured) return undefined;

  const sha256 = {
    firecracker: options.firecrackerBinarySha256 as string | undefined,
    jailer: options.firecrackerJailerSha256 as string | undefined,
    kernel: options.firecrackerKernelSha256 as string | undefined,
    rootfs: options.firecrackerRootfsSha256 as string | undefined,
    supervisor: options.firecrackerSupervisorSha256 as string | undefined,
  };

  return {
    previewEnabled: options.firecrackerPreview === true,
    firecrackerBinary:
      (options.firecrackerBinary as string | undefined) ?? FIRECRACKER_DEFAULT_BINARY,
    jailerBinary:
      (options.firecrackerJailerBinary as string | undefined) ??
      FIRECRACKER_DEFAULT_JAILER_BINARY,
    kernelPath: options.firecrackerKernel as string | undefined,
    rootfsPath: options.firecrackerRootfs as string | undefined,
    supervisorPath: options.firecrackerSupervisor as string | undefined,
    vcpuCount: parsePositiveIntegerOption(
      options.firecrackerVcpus,
      '--firecracker-vcpus',
      FIRECRACKER_DEFAULT_VCPU_COUNT,
    ),
    memoryMib: parsePositiveIntegerOption(
      options.firecrackerMemoryMib,
      '--firecracker-memory-mib',
      FIRECRACKER_DEFAULT_MEMORY_MIB,
    ),
    apiTimeoutMs: parsePositiveIntegerOption(
      options.firecrackerApiTimeoutMs,
      '--firecracker-api-timeout-ms',
      FIRECRACKER_DEFAULT_API_TIMEOUT_MS,
    ),
    sha256: Object.values(sha256).some((value) => value !== undefined)
      ? sha256
      : undefined,
  };
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
 * plus vcpu/memory/timeout settings). `selected` mirrors the Firecracker
 * pattern: `--container-runtime cloud-hypervisor` requires explicit
 * `--cloud-hypervisor-preview` opt-in and full artifact/digest
 * configuration, enforced by
 * `assertCloudHypervisorRuntimeCompatibility` in
 * `src/cloud-hypervisor/runtime-validation.ts`.
 */
function buildCloudHypervisorConfig(
  options: Record<string, unknown>,
): WrapperConfig['cloudHypervisor'] {
  const selected = options.containerRuntime === 'cloud-hypervisor';
  const configured = options.cloudHypervisorPreview === true
    || [
      'cloudHypervisorBinary',
      'cloudHypervisorKernel',
      'cloudHypervisorRootfs',
      'cloudHypervisorSupervisor',
      'cloudHypervisorVcpus',
      'cloudHypervisorMemoryMib',
      'cloudHypervisorApiTimeoutMs',
      'cloudHypervisorBinarySha256',
      'cloudHypervisorKernelSha256',
      'cloudHypervisorRootfsSha256',
      'cloudHypervisorSupervisorSha256',
    ].some((key) => options[key] !== undefined);
  if (!selected && !configured) return undefined;

  const sha256 = {
    cloudHypervisor: options.cloudHypervisorBinarySha256 as string | undefined,
    kernel: options.cloudHypervisorKernelSha256 as string | undefined,
    rootfs: options.cloudHypervisorRootfsSha256 as string | undefined,
    supervisor: options.cloudHypervisorSupervisorSha256 as string | undefined,
  };

  return {
    previewEnabled: options.cloudHypervisorPreview === true,
    cloudHypervisorBinary:
      (options.cloudHypervisorBinary as string | undefined) ?? CLOUD_HYPERVISOR_DEFAULT_BINARY,
    kernelPath: options.cloudHypervisorKernel as string | undefined,
    rootfsPath: options.cloudHypervisorRootfs as string | undefined,
    supervisorPath: options.cloudHypervisorSupervisor as string | undefined,
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

function buildChrootIdentity(
  options: Record<string, unknown>
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
    home: options.chrootIdentityHome as string | undefined,
    user: options.chrootIdentityUser as string | undefined,
    uid,
    gid,
  };
}

function buildDindConfig(options: Record<string, unknown>): WrapperConfig['dind'] {
  const stageEngineBinary = (
    options.dindStageEngineBinaryPath !== undefined
    || options.dindStageEngineBinaryTargetPath !== undefined
  )
    ? {
      path: options.dindStageEngineBinaryPath as string | undefined,
      targetPath: options.dindStageEngineBinaryTargetPath as string | undefined,
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
    preStageDirs: options.dindPreStageDirs as boolean | undefined,
    workDir: options.dindWorkDir as string | undefined,
    stagingImage: options.dindStagingImage as string | undefined,
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
