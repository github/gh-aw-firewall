import { buildConfig } from '../commands/build-config';

type BuildConfigInputs = Parameters<typeof buildConfig>[0];

/** Minimal valid inputs for buildConfig */
export function buildMinimalBuildConfigInput(
  overrides: Partial<BuildConfigInputs> = {},
): BuildConfigInputs {
  return {
    options: {
      keepContainers: false,
      tty: false,
      workDir: '/tmp/awf-test',
      buildLocal: false,
      skipPull: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      envAll: false,
      enableHostAccess: false,
      sslBump: false,
      enableDind: false,
      enableDlp: false,
      enableApiProxy: false,
      anthropicAutoCache: false,
      diagnosticLogs: false,
    },
    agentCommand: 'echo hello',
    logLevel: 'info',
    allowedDomains: ['github.com'],
    blockedDomains: [],
    localhostDetected: false,
    additionalEnv: {},
    volumeMounts: undefined,
    upstreamProxy: undefined,
    dnsServers: ['8.8.8.8'],
    dnsOverHttps: undefined,
    allowedUrls: undefined,
    memoryLimit: undefined,
    pidsLimit: undefined,
    agentImage: undefined,
    modelAliases: undefined,
    allowedModels: undefined,
    disallowedModels: undefined,
    maxEffectiveTokens: undefined,
    maxAiCredits: undefined,
    effectiveTokenModelMultipliers: undefined,
    effectiveTokenDefaultModelMultiplier: undefined,
    maxRuns: undefined,
    maxPermissionDenied: undefined,
    maxCacheMisses: undefined,
    resolvedCopilotApiTarget: undefined,
    resolvedCopilotApiBasePath: undefined,
    dockerHostPathPrefix: undefined,
    ...overrides,
  };
}
