import { WrapperConfig, LogLevel, UpstreamProxyConfig } from '../types';
import { OPENAI_ENV, ANTHROPIC_ENV, GEMINI_ENV, COPILOT_ENV, OIDC_AUTH_ENV_MAPPING } from '../api-proxy-env-constants';

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
 * API keys are resolved from the process environment here to keep credential
 * access centralised in one place.
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

  const chrootIdentityUid = parseOptionalIntegerOption(options.chrootIdentityUid);
  const chrootIdentityGid = parseOptionalIntegerOption(options.chrootIdentityGid);
  const chrootIdentity = (
    options.chrootIdentityHome !== undefined ||
    options.chrootIdentityUser !== undefined ||
    chrootIdentityUid !== undefined ||
    chrootIdentityGid !== undefined
  )
    ? {
      home: options.chrootIdentityHome as string | undefined,
      user: options.chrootIdentityUser as string | undefined,
      uid: chrootIdentityUid,
      gid: chrootIdentityGid,
    }
    : undefined;
  const dind = (
    options.dindPreStageDirs !== undefined ||
    options.dindWorkDir !== undefined ||
    options.dindStagingImage !== undefined ||
    options.dindStageEngineBinaryPath !== undefined ||
    options.dindStageEngineBinaryTargetPath !== undefined
  )
    ? {
      preStageDirs: options.dindPreStageDirs as boolean | undefined,
      workDir: options.dindWorkDir as string | undefined,
      stagingImage: options.dindStagingImage as string | undefined,
      stageEngineBinary: (
        options.dindStageEngineBinaryPath !== undefined ||
        options.dindStageEngineBinaryTargetPath !== undefined
      )
        ? {
          path: options.dindStageEngineBinaryPath as string | undefined,
          targetPath: options.dindStageEngineBinaryTargetPath as string | undefined,
        }
        : undefined,
    }
    : undefined;

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
    modelFallback: options.modelFallback as { enabled?: boolean; strategy?: 'middle_power' } | undefined,
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
    debugTokens: (options.debugTokens as boolean | undefined) ?? (process.env.AWF_DEBUG_TOKENS === '1' ? true : undefined),
    tokenLogDir: (options.tokenLogDir as string | undefined) ?? (process.env.AWF_TOKEN_LOG_DIR?.trim() || undefined),
    captureBlockedRequests: (options.captureBlockedRequests as boolean | 'summary' | 'redacted' | 'full' | undefined) ??
      (process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS
        ? (process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS as 'summary' | 'redacted' | 'full')
        : undefined),
    maxCapturedBytes: (options.maxCapturedBytes as number | undefined) ??
      (process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES ? Number(process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES) : undefined),
    openaiApiKey: process.env[OPENAI_ENV.KEY],
    anthropicApiKey: process.env[ANTHROPIC_ENV.KEY],
    copilotGithubToken: process.env[COPILOT_ENV.GITHUB_TOKEN],
    copilotProviderApiKey: process.env[COPILOT_ENV.PROVIDER_API_KEY],
    copilotProviderType:
      (options.copilotProviderType as string | undefined) || process.env[COPILOT_ENV.PROVIDER_TYPE],
    copilotProviderBaseUrl:
      (options.copilotProviderBaseUrl as string | undefined) || process.env[COPILOT_ENV.PROVIDER_BASE_URL],
    geminiApiKey: process.env[GEMINI_ENV.KEY],
    copilotApiTarget: resolvedCopilotApiTarget,
    copilotApiBasePath: resolvedCopilotApiBasePath,
    copilotByokExtraHeaders: options.copilotByokExtraHeaders as Record<string, string> | undefined,
    copilotByokExtraBodyFields: options.copilotByokExtraBodyFields as Record<string, string> | undefined,
    copilotByokSessionId: options.copilotByokSessionId as string | undefined,
    openaiApiTarget:
      (options.openaiApiTarget as string | undefined) || process.env[OPENAI_ENV.TARGET],
    openaiApiBasePath:
      (options.openaiApiBasePath as string | undefined) || process.env[OPENAI_ENV.BASE_PATH],
    anthropicApiTarget:
      (options.anthropicApiTarget as string | undefined) || process.env[ANTHROPIC_ENV.TARGET],
    anthropicApiBasePath:
      (options.anthropicApiBasePath as string | undefined) || process.env[ANTHROPIC_ENV.BASE_PATH],
    openaiApiAuthHeader:
      (options.openaiApiAuthHeader as string | undefined) || process.env[OPENAI_ENV.AUTH_HEADER],
    anthropicApiAuthHeader:
      (options.anthropicApiAuthHeader as string | undefined) || process.env[ANTHROPIC_ENV.AUTH_HEADER],
    anthropicTokenUrl:
      (options.anthropicTokenUrl as string | undefined) || process.env.AWF_AUTH_ANTHROPIC_TOKEN_URL,
    authType: (options.authType as string | undefined) || process.env.AWF_AUTH_TYPE,
    authProvider: (options.authProvider as string | undefined) || process.env.AWF_AUTH_PROVIDER,
    authOidcAudience: (options.authOidcAudience as string | undefined) || process.env.AWF_AUTH_OIDC_AUDIENCE,
    ...Object.fromEntries(
      OIDC_AUTH_ENV_MAPPING
        .filter(m => !['authType', 'authProvider', 'authOidcAudience'].includes(m.configKey))
        .map(({ configKey, envVar }) => [
          configKey,
          (options[configKey] as string | undefined) || process.env[envVar],
        ])
        .filter(([, v]) => v !== undefined)
    ),
    geminiApiTarget:
      (options.geminiApiTarget as string | undefined) || process.env[GEMINI_ENV.TARGET],
    geminiApiBasePath:
      (options.geminiApiBasePath as string | undefined) || process.env[GEMINI_ENV.BASE_PATH],
    difcProxyHost: options.difcProxyHost as string | undefined,
    difcProxyCaCert: options.difcProxyCaCert as string | undefined,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    diagnosticLogs: (options.diagnosticLogs as boolean) || false,
    awfDockerHost: options.dockerHost as string | undefined,
    upstreamProxy,
    dockerHostPathPrefix,
    chrootBinariesSourcePath: options.chrootBinariesSourcePath as string | undefined,
    chrootIdentity,
    dind,
    runnerTopology: options.runnerTopology as 'arc-dind' | undefined,
    runnerSysrootImage: options.runnerSysrootImage as string | undefined,
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
