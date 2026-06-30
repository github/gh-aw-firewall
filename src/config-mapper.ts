import type { AwfFileConfig } from './config-file';

function joinComma(value: string[] | undefined): string | undefined {
  // Empty arrays intentionally map to undefined so they don't override defaults with "".
  if (!value || value.length === 0) return undefined;
  return value.join(',');
}

function joinPorts(value: string[] | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

function toStringIfDefined(value: number | undefined): string | undefined {
  return value !== undefined ? String(value) : undefined;
}

export function mapAwfFileConfigToCliOptions(config: AwfFileConfig): Record<string, unknown> {
  const geminiTargetConfig = config.apiProxy?.targets?.gemini;
  const antigravityTargetConfig = config.apiProxy?.targets?.antigravity;

  return {
    allowDomains: joinComma(config.network?.allowDomains),
    blockDomains: joinComma(config.network?.blockDomains),
    dnsServers: joinComma(config.network?.dnsServers),
    upstreamProxy: config.network?.upstreamProxy,
    networkIsolation: config.network?.isolation,
    topologyAttach: config.network?.topologyAttach,

    enableApiProxy: config.apiProxy?.enabled,
    enableTokenSteering: config.apiProxy?.enableTokenSteering,
    anthropicAutoCache: config.apiProxy?.anthropicAutoCache,
    anthropicCacheTailTtl: config.apiProxy?.anthropicCacheTailTtl as '5m' | '1h' | undefined,
    maxEffectiveTokens: config.apiProxy?.maxEffectiveTokens,
    maxAiCredits: config.apiProxy?.maxAiCredits,
    defaultAiCreditsPricing: config.apiProxy?.defaultAiCreditsPricing,
    effectiveTokenModelMultipliers: config.apiProxy?.modelMultipliers,
    effectiveTokenDefaultModelMultiplier: config.apiProxy?.defaultModelMultiplier,
    maxModelMultiplierCap: config.apiProxy?.maxModelMultiplierCap,
    maxRuns: config.apiProxy?.maxTurns ?? config.apiProxy?.maxRuns,
    maxPermissionDenied: config.apiProxy?.maxPermissionDenied,
    maxCacheMisses: config.apiProxy?.maxCacheMisses,
    requestedModel: config.apiProxy?.requestedModel,
    modelFallback: config.apiProxy?.modelFallback,
    copilotProviderType: config.apiProxy?.modelRouter?.providerType,
    copilotProviderBaseUrl: config.apiProxy?.modelRouter?.baseUrl,
    openaiApiTarget: config.apiProxy?.targets?.openai?.host,
    openaiApiBasePath: config.apiProxy?.targets?.openai?.basePath,
    openaiApiAuthHeader: config.apiProxy?.targets?.openai?.authHeader,
    anthropicApiTarget: config.apiProxy?.targets?.anthropic?.host,
    anthropicApiBasePath: config.apiProxy?.targets?.anthropic?.basePath,
    anthropicApiAuthHeader: config.apiProxy?.targets?.anthropic?.authHeader,
    copilotApiTarget: config.apiProxy?.targets?.copilot?.host,
    copilotByokExtraHeaders: config.apiProxy?.targets?.copilot?.extraHeaders,
    copilotByokExtraBodyFields: config.apiProxy?.targets?.copilot?.extraBodyFields,
    copilotByokSessionId: config.apiProxy?.targets?.copilot?.sessionId,
    geminiApiTarget: antigravityTargetConfig?.host ?? geminiTargetConfig?.host,
    geminiApiBasePath: antigravityTargetConfig?.basePath ?? geminiTargetConfig?.basePath,
    modelAliases: config.apiProxy?.models,
    allowedModels: config.apiProxy?.allowedModels,
    disallowedModels: config.apiProxy?.disallowedModels,
    debugTokens: config.apiProxy?.logging?.debugTokens,
    tokenLogDir: config.apiProxy?.logging?.tokenLogDir,
    captureBlockedRequests: config.apiProxy?.diagnostics?.captureBlockedRequests,
    maxCapturedBytes: config.apiProxy?.diagnostics?.maxCapturedBytes,
    authType: config.apiProxy?.auth?.type,
    authProvider: config.apiProxy?.auth?.provider,
    authOidcAudience: config.apiProxy?.auth?.oidcAudience,
    authAzureTenantId: config.apiProxy?.auth?.azureTenantId,
    authAzureClientId: config.apiProxy?.auth?.azureClientId,
    authAzureScope: config.apiProxy?.auth?.azureScope,
    authAzureCloud: config.apiProxy?.auth?.azureCloud,
    authAwsRoleArn: config.apiProxy?.auth?.awsRoleArn,
    authAwsRegion: config.apiProxy?.auth?.awsRegion,
    authAwsRoleSessionName: config.apiProxy?.auth?.awsRoleSessionName,
    authGcpWorkloadIdentityProvider: config.apiProxy?.auth?.gcpWorkloadIdentityProvider,
    authGcpServiceAccount: config.apiProxy?.auth?.gcpServiceAccount,
    authGcpScope: config.apiProxy?.auth?.gcpScope,
    authAnthropicFederationRuleId: config.apiProxy?.auth?.anthropicFederationRuleId,
    authAnthropicOrganizationId: config.apiProxy?.auth?.anthropicOrganizationId,
    authAnthropicServiceAccountId: config.apiProxy?.auth?.anthropicServiceAccountId,
    authAnthropicWorkspaceId: config.apiProxy?.auth?.anthropicWorkspaceId,
    anthropicTokenUrl: config.apiProxy?.auth?.anthropicTokenUrl,

    sslBump: config.security?.sslBump,
    enableDlp: config.security?.enableDlp,
    enableHostAccess: config.security?.enableHostAccess,
    allowHostPorts: joinPorts(config.security?.allowHostPorts),
    allowHostServicePorts: joinPorts(config.security?.allowHostServicePorts),
    difcProxyHost: config.security?.difcProxy?.host,
    difcProxyCaCert: config.security?.difcProxy?.caCert,

    memoryLimit: config.container?.memoryLimit,
    agentTimeout: toStringIfDefined(config.container?.agentTimeout),
    enableDind: config.container?.enableDind,
    workDir: config.container?.workDir,
    containerWorkdir: config.container?.containerWorkDir,
    imageRegistry: config.container?.imageRegistry,
    imageTag: config.container?.imageTag,
    skipPull: config.container?.skipPull,
    buildLocal: config.container?.buildLocal,
    agentImage: config.container?.agentImage,
    tty: config.container?.tty,
    dockerHost: config.container?.dockerHost,
    dockerHostPathPrefix: config.container?.dockerHostPathPrefix,
    runnerToolCachePath: config.container?.runnerToolCachePath,
    chrootBinariesSourcePath: config.chroot?.binariesSourcePath,
    chrootIdentityHome: config.chroot?.identity?.home,
    chrootIdentityUser: config.chroot?.identity?.user,
    chrootIdentityUid: toStringIfDefined(config.chroot?.identity?.uid),
    chrootIdentityGid: toStringIfDefined(config.chroot?.identity?.gid),
    dindPreStageDirs: config.dind?.preStageDirs,
    dindWorkDir: config.dind?.workDir,
    dindStagingImage: config.dind?.stagingImage,
    dindStageEngineBinaryPath: config.dind?.stageEngineBinary?.path,
    dindStageEngineBinaryTargetPath: config.dind?.stageEngineBinary?.targetPath,

    envFile: config.environment?.envFile,
    envAll: config.environment?.envAll,
    excludeEnv: config.environment?.excludeEnv,

    logLevel: config.logging?.logLevel,
    diagnosticLogs: config.logging?.diagnosticLogs,
    auditDir: config.logging?.auditDir,
    proxyLogsDir: config.logging?.proxyLogsDir,
    sessionStateDir: config.logging?.sessionStateDir,

    // CLI has a negated flag (--no-rate-limit). Only explicit false maps to that flag.
    rateLimit: config.rateLimiting?.enabled === false ? false : undefined,
    rateLimitRpm: toStringIfDefined(config.rateLimiting?.requestsPerMinute),
    rateLimitRph: toStringIfDefined(config.rateLimiting?.requestsPerHour),
    rateLimitBytesPm: toStringIfDefined(config.rateLimiting?.bytesPerMinute),

    platformType: config.platform?.type,

    runnerTopology: config.runner?.topology,
    sysrootImage: config.runner?.sysrootImage,
  };
}
