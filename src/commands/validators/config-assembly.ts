import * as path from 'path';
import * as fs from 'fs';
import { WrapperConfig } from '../../types';
import { logger } from '../../logger';
import {
  validateApiProxyConfig,
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
} from '../../api-proxy-config';
import { validateCopilotModel } from '../../copilot-model';
import {
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
  validateSkipPullWithBuildLocal,
  validateAllowHostPorts,
  applyHostServicePortsConfig,
  applyAgentTimeout,
} from '../../option-parsers';
import { buildConfig } from '../build-config';
import { LogAndLimitsResult } from './log-and-limits';
import { NetworkOptionsResult } from './network-options';
import { AgentOptionsResult } from './agent-options';

/**
 * Assembles the {@link WrapperConfig} from pre-validated partial results and
 * runs all post-assembly validation guards.
 *
 * This is the final stage of the validation pipeline.  Every input must
 * already be validated by the earlier stages; this function only:
 *  1. Calls {@link buildConfig} to merge everything into a single object.
 *  2. Runs post-config guards that require the fully-assembled config (docker
 *     host URI format, rate limits, feature-flag compatibility, port rules,
 *     API-proxy configuration warnings).
 *
 * Calls `process.exit(1)` on any validation failure so the caller always
 * receives a fully-validated, ready-to-use config object.
 */
export function assembleAndValidateConfig(
  options: Record<string, unknown>,
  agentCommand: string,
  logAndLimits: LogAndLimitsResult,
  networkOptions: NetworkOptionsResult,
  agentOptions: AgentOptionsResult,
): WrapperConfig {
  const readCopilotModelFromEnvFiles = (envFile: unknown): string | undefined => {
    const envFiles = Array.isArray(envFile) ? envFile : envFile ? [envFile] : [];
    let lastSeen: string | undefined;
    for (const candidate of envFiles) {
      if (typeof candidate !== 'string' || candidate.trim() === '') continue;
      try {
        const envFilePath = path.isAbsolute(candidate)
          ? candidate
          : path.resolve(process.cwd(), candidate);
        const envFileContents = fs.readFileSync(envFilePath, 'utf8');
        for (const line of envFileContents.split(/\r?\n/)) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith('#')) continue;
          const match = trimmedLine.match(/^(?:export\s+)?COPILOT_MODEL\s*=\s*(.*)$/);
          if (match) {
            lastSeen = match[1]?.trim() || '';
          }
        }
      } catch {
        // Ignore unreadable env files here; this check is only for a pre-flight warning.
      }
    }
    return lastSeen;
  };

  // --- Config assembly -----------------------------------------------------

  const config = buildConfig({
    options,
    agentCommand,
    logLevel: logAndLimits.logLevel,
    allowedDomains: networkOptions.allowedDomains,
    blockedDomains: networkOptions.blockedDomains,
    localhostDetected: networkOptions.localhostResult.localhostDetected,
    additionalEnv: agentOptions.additionalEnv,
    volumeMounts: agentOptions.volumeMounts,
    upstreamProxy: networkOptions.upstreamProxy,
    dnsServers: networkOptions.dnsServers,
    dnsOverHttps: networkOptions.dnsOverHttps,
    allowedUrls: agentOptions.allowedUrls,
    memoryLimit: logAndLimits.memoryLimit,
    agentImage: logAndLimits.agentImage,
    modelAliases: logAndLimits.modelAliases,
    maxEffectiveTokens: logAndLimits.maxEffectiveTokens,
    maxAiCredits: logAndLimits.maxAiCredits,
    effectiveTokenModelMultipliers: logAndLimits.effectiveTokenModelMultipliers,
    effectiveTokenDefaultModelMultiplier: logAndLimits.effectiveTokenDefaultModelMultiplier,
    maxModelMultiplierCap: logAndLimits.maxModelMultiplierCap,
    maxRuns: logAndLimits.maxRuns,
    maxPermissionDenied: logAndLimits.maxPermissionDenied,
    resolvedCopilotApiTarget: networkOptions.resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath: networkOptions.resolvedCopilotApiBasePath,
    dockerHostPathPrefix: networkOptions.dockerHostPathPrefixResolution.dockerHostPathPrefix,
  });

  // --- Post-config validations ---------------------------------------------

  // Apply --docker-host override for AWF's own container operations.
  // This must be called before startContainers/stopContainers/runAgentCommand.
  if (config.awfDockerHost && !config.awfDockerHost.startsWith('unix://')) {
    logger.error(`❌ --docker-host must be a unix:// socket URI, got: ${config.awfDockerHost}`);
    logger.error('   Example: --docker-host unix:///run/user/1000/docker.sock');
    process.exit(1);
  }
  if (config.dockerHostPathPrefix && !config.dockerHostPathPrefix.startsWith('/')) {
    logger.error(
      `❌ --docker-host-path-prefix must be an absolute path, got: ${config.dockerHostPathPrefix}`,
    );
    logger.error('   Example: --docker-host-path-prefix /host');
    process.exit(1);
  }
  if (config.chrootBinariesSourcePath && !config.chrootBinariesSourcePath.startsWith('/')) {
    logger.error(
      `❌ chroot.binariesSourcePath must be an absolute path, got: ${config.chrootBinariesSourcePath}`,
    );
    logger.error('   Example (stdin config): {"chroot":{"binariesSourcePath":"/tmp/gh-aw/runner-bin"}}');
    process.exit(1);
  }
  if (config.chrootBinariesSourcePath === '/') {
    logger.error('❌ chroot.binariesSourcePath cannot be "/"');
    logger.error('   Provide a specific binaries directory, for example /tmp/gh-aw/runner-bin');
    process.exit(1);
  }

  // Parse and validate --agent-timeout
  applyAgentTimeout(options.agentTimeout as string | undefined, config, logger);

  // Build rate limit config when API proxy is enabled
  if (config.enableApiProxy) {
    const rateLimitResult = buildRateLimitConfig(options);
    if ('error' in rateLimitResult) {
      logger.error(`❌ ${rateLimitResult.error}`);
      process.exit(1);
    }
    config.rateLimitConfig = rateLimitResult.config;
    logger.debug(
      `Rate limiting: enabled=${rateLimitResult.config.enabled}, rpm=${rateLimitResult.config.rpm}, rph=${rateLimitResult.config.rph}, bytesPm=${rateLimitResult.config.bytesPm}`,
    );
  }

  // Error if rate limit flags are used without --enable-api-proxy
  const rateLimitFlagValidation = validateRateLimitFlags(config.enableApiProxy ?? false, options);
  if (!rateLimitFlagValidation.valid) {
    logger.error(rateLimitFlagValidation.error!);
    process.exit(1);
  }

  // Error if --enable-token-steering is used without --enable-api-proxy
  const enableTokenSteeringValidation = validateEnableTokenSteeringFlag(
    config.enableApiProxy ?? false,
    config.enableTokenSteering ?? false,
  );
  if (!enableTokenSteeringValidation.valid) {
    logger.error(enableTokenSteeringValidation.error!);
    process.exit(1);
  }

  // Warn if --env-all is used
  if (config.envAll) {
    logger.warn('⚠️  Using --env-all: All host environment variables will be passed to container');
    logger.warn('   This may expose sensitive credentials if logs or configs are shared');
  }

  // Log --env-file usage
  if (config.envFile) {
    logger.debug(`Loading environment variables from file: ${config.envFile}`);
  }

  // Validate --allow-host-service-ports (port format & range)
  const servicePortsResult = applyHostServicePortsConfig(
    config.allowHostServicePorts,
    config.enableHostAccess,
    logger,
  );
  if (!servicePortsResult.valid) {
    logger.error(`❌ ${servicePortsResult.error}`);
    process.exit(1);
  }
  config.enableHostAccess = servicePortsResult.enableHostAccess;

  // Validate --allow-host-ports requires --enable-host-access
  const hostPortsValidation = validateAllowHostPorts(
    config.allowHostPorts,
    config.enableHostAccess,
  );
  if (!hostPortsValidation.valid) {
    logger.error(`❌ ${hostPortsValidation.error}`);
    process.exit(1);
  }

  // Error if --skip-pull is used with --build-local (incompatible flags)
  const skipPullValidation = validateSkipPullWithBuildLocal(config.skipPull, config.buildLocal);
  if (!skipPullValidation.valid) {
    logger.error(`❌ ${skipPullValidation.error}`);
    process.exit(1);
  }

  // Warn if --enable-host-access is used with host.docker.internal in allowed domains
  if (config.enableHostAccess) {
    const hasHostDomain = networkOptions.allowedDomains.some(
      (d) => d === 'host.docker.internal' || d.endsWith('.host.docker.internal'),
    );
    if (hasHostDomain) {
      logger.warn('⚠️  Host access enabled with host.docker.internal in allowed domains');
      logger.warn('   Containers can access ANY service running on the host machine');
      logger.warn('   Only use this for trusted workloads (e.g., MCP gateways)');
    }
  }

  // Validate and warn about API proxy configuration
  // Pass booleans (not actual keys) to prevent sensitive data flow to logger.
  // `copilotByokDirect` means the user supplied COPILOT_PROVIDER_API_KEY for direct-BYOK
  // mode (Azure Foundry, OpenRouter, etc.) without a GitHub token; the sidecar still
  // routes through it, so for "is there a Copilot path?" purposes either signal counts.
  const copilotByokDirect = !!config.copilotProviderApiKey;
  const apiProxyValidation = validateApiProxyConfig(
    config.enableApiProxy || false,
    !!config.openaiApiKey,
    !!config.anthropicApiKey,
    !!config.copilotGithubToken || copilotByokDirect,
    !!config.geminiApiKey,
  );

  // Log API proxy status at info level for visibility
  if (config.enableApiProxy) {
    const copilotStatus = config.copilotGithubToken
      ? 'true (github-token)'
      : copilotByokDirect
        ? 'true (byok-direct)'
        : 'false';
    logger.info(
      `API proxy enabled: OpenAI=${!!config.openaiApiKey}, Anthropic=${!!config.anthropicApiKey}, Copilot=${copilotStatus}, Gemini=${!!config.geminiApiKey}`,
    );
  }

  for (const warning of apiProxyValidation.warnings) {
    logger.warn(warning);
  }
  for (const msg of apiProxyValidation.debugMessages) {
    logger.debug(msg);
  }

  // Warn if custom API targets are not in --allow-domains
  emitApiProxyTargetWarnings(config, networkOptions.allowedDomains, logger.warn.bind(logger));

  // Log CLI proxy status
  emitCliProxyStatusLogs(config, logger.info.bind(logger), logger.warn.bind(logger));

  // Check if COPILOT_MODEL is set via --env/-e flags, --env-file, or host env (when --env-all is active)
  const copilotModelFromFlags = agentOptions.additionalEnv.COPILOT_MODEL;
  const copilotModelInEnvFile = readCopilotModelFromEnvFiles(
    (config as { envFile?: unknown }).envFile,
  );
  const copilotModelInHostEnv = config.envAll ? process.env.COPILOT_MODEL : undefined;
  const copilotModel = (
    copilotModelFromFlags ??
    copilotModelInEnvFile ??
    copilotModelInHostEnv
  )?.trim();
  warnClassicPATWithCopilotModel(
    config.copilotGithubToken?.startsWith('ghp_') ?? false,
    !!copilotModel,
    logger.warn.bind(logger),
  );

  if (copilotModel && config.copilotGithubToken) {
    const validation = validateCopilotModel(copilotModel);
    if (!validation.valid) {
      logger.error(validation.message);
      process.exit(1);
    }

    if (validation.resolvedModel !== copilotModel) {
      logger.info(
        `Normalized COPILOT_MODEL value '${copilotModel}' -> '${validation.resolvedModel}'`,
      );
    }
    config.additionalEnv = {
      ...(config.additionalEnv ?? {}),
      COPILOT_MODEL: validation.resolvedModel,
    };
  }

  return config;
}
