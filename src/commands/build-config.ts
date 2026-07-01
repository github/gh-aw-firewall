import { WrapperConfig, LogLevel, UpstreamProxyConfig } from '../types';
import { resolveApiCredentials } from './resolve-credentials';

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
  blockedDomains: string[];
  localhostDetected: boolean;
  additionalEnv: Record<string, string>;
  volumeMounts: string[] | undefined;
  upstreamProxy: UpstreamProxyConfig | undefined;
  dnsServers: string[];
  dnsOverHttps: string | undefined;
  allowedUrls: string[] | undefined;
  memoryLimit: string | undefined;
  agentImage: string | undefined;
  modelAliases: Record<string, string[]> | undefined;
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
    blockedDomains,
    localhostDetected,
    additionalEnv,
    volumeMounts,
    upstreamProxy,
    dnsServers,
    dnsOverHttps,
    allowedUrls,
    memoryLimit,
    agentImage,
    modelAliases,
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
  const apiCredentials = resolveApiCredentials(options, {
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
  });

  return {
    allowedDomains,
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
    dnsOverHttps,
    memoryLimit,
    proxyLogsDir: options.proxyLogsDir as string | undefined,
    auditDir: (options.auditDir as string | undefined) || process.env.AWF_AUDIT_DIR,
    sessionStateDir:
      (options.sessionStateDir as string | undefined) || process.env.AWF_SESSION_STATE_DIR,
    runnerToolCachePath: options.runnerToolCachePath as string | undefined,
    enableHostAccess: options.enableHostAccess as boolean,
    networkIsolation: options.networkIsolation as boolean,
    topologyAttach: options.topologyAttach as string[] | undefined,
    localhostDetected,
    allowHostPorts: options.allowHostPorts as string | undefined,
    allowHostServicePorts: options.allowHostServicePorts as string | undefined,
    sslBump: options.sslBump as boolean,
    enableDind: options.enableDind as boolean,
    enableDlp: options.enableDlp as boolean,
    allowedUrls,
    enableApiProxy: options.enableApiProxy as boolean,
    modelFallback:
      options.modelFallback as { enabled?: boolean; strategy?: 'middle_power' } | undefined,
    requestedModel: options.requestedModel as string | undefined,
    anthropicAutoCache: options.anthropicAutoCache as boolean,
    anthropicCacheTailTtl: options.anthropicCacheTailTtl as '5m' | '1h' | undefined,
    modelAliases,
    maxEffectiveTokens,
    maxAiCredits,
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
    runnerTopology: options.runnerTopology as 'standard' | 'arc-dind' | undefined,
    sysrootImage: options.sysrootImage as string | undefined,
    chrootBinariesSourcePath: options.chrootBinariesSourcePath as string | undefined,
    chrootIdentity,
    dind,
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
