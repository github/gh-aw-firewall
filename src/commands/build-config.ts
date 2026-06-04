import { WrapperConfig, LogLevel, UpstreamProxyConfig } from '../types';

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
  effectiveTokenModelMultipliers: Record<string, number> | undefined;
  effectiveTokenDefaultModelMultiplier: number | undefined;
  maxModelMultiplierCap?: number;
  maxRuns: number | undefined;
  maxPermissionDenied: number | undefined;
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
    effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier,
    maxModelMultiplierCap,
    maxRuns,
    maxPermissionDenied,
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
    dockerHostPathPrefix,
  } = inputs;

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
    enableHostAccess: options.enableHostAccess as boolean,
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
    effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier,
    maxModelMultiplierCap,
    maxRuns,
    maxPermissionDenied,
    enableTokenSteering: options.enableTokenSteering as boolean,
    debugTokens: (options.debugTokens as boolean | undefined) ?? (process.env.AWF_DEBUG_TOKENS === '1' ? true : undefined),
    tokenLogDir: (options.tokenLogDir as string | undefined) ?? (process.env.AWF_TOKEN_LOG_DIR?.trim() || undefined),
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
    copilotProviderApiKey: process.env.COPILOT_PROVIDER_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    copilotApiTarget: resolvedCopilotApiTarget,
    copilotApiBasePath: resolvedCopilotApiBasePath,
    copilotByokExtraHeaders: options.copilotByokExtraHeaders as Record<string, string> | undefined,
    copilotByokExtraBodyFields: options.copilotByokExtraBodyFields as Record<string, string> | undefined,
    openaiApiTarget:
      (options.openaiApiTarget as string | undefined) || process.env.OPENAI_API_TARGET,
    openaiApiBasePath:
      (options.openaiApiBasePath as string | undefined) || process.env.OPENAI_API_BASE_PATH,
    anthropicApiTarget:
      (options.anthropicApiTarget as string | undefined) || process.env.ANTHROPIC_API_TARGET,
    anthropicApiBasePath:
      (options.anthropicApiBasePath as string | undefined) || process.env.ANTHROPIC_API_BASE_PATH,
    openaiApiAuthHeader:
      (options.openaiApiAuthHeader as string | undefined) || process.env.AWF_OPENAI_AUTH_HEADER,
    anthropicApiAuthHeader:
      (options.anthropicApiAuthHeader as string | undefined) || process.env.AWF_ANTHROPIC_AUTH_HEADER,
    anthropicTokenUrl:
      (options.anthropicTokenUrl as string | undefined) || process.env.AWF_AUTH_ANTHROPIC_TOKEN_URL,
    geminiApiTarget:
      (options.geminiApiTarget as string | undefined) || process.env.GEMINI_API_TARGET,
    geminiApiBasePath:
      (options.geminiApiBasePath as string | undefined) || process.env.GEMINI_API_BASE_PATH,
    difcProxyHost: options.difcProxyHost as string | undefined,
    difcProxyCaCert: options.difcProxyCaCert as string | undefined,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    diagnosticLogs: (options.diagnosticLogs as boolean) || false,
    awfDockerHost: options.dockerHost as string | undefined,
    upstreamProxy,
    dockerHostPathPrefix,
  };
}
