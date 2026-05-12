import * as path from 'path';
import * as fs from 'fs';
import { WrapperConfig, LogLevel } from '../types';
import { logger } from '../logger';
import {
  writeConfigs,
  startContainers,
  runAgentCommand,
  stopContainers,
  cleanup,
  preserveIptablesAudit,
  fastKillAgentContainer,
  collectDiagnosticLogs,
  setAwfDockerHost,
} from '../docker-manager';
import {
  ensureFirewallNetwork,
  setupHostIptables,
  cleanupHostIptables,
} from '../host-iptables';
import { runMainWorkflow } from '../cli-workflow';
import { redactSecrets } from '../redact-secrets';
import { SQUID_DANGEROUS_CHARS } from '../domain-patterns';
import { parseDomains, processAgentImageOption } from '../domain-utils';
import {
  validateApiProxyConfig,
  validateAnthropicCacheTailTtl,
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
} from '../api-proxy-config';
import {
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableOpenCodeFlag,
  validateSkipPullWithBuildLocal,
  validateAllowHostPorts,
  applyHostServicePortsConfig,
  parseMemoryLimit,
  applyAgentTimeout,
  checkDockerHost,
  resolveDockerHostPathPrefix,
  joinShellArgs,
  parseEnvironmentVariables,
  parseVolumeMounts,
  parseModelMultipliersCli,
} from '../option-parsers';
import { resolveCopilotApiKey } from '../copilot-api-resolver';
import { applyConfigFilePrecedence, resolveAllowedDomains, resolveBlockedDomains } from './preflight';
import { resolveNetworkConfig } from './network-setup';
import { registerSignalHandlers } from './signal-handler';

/**
 * Resolves the Commander option-value source for a given option name.
 * Injected to decouple the action handler from the global program instance,
 * enabling independent unit testing.
 */
type OptionSourceResolver = (optionName: string) => string | undefined;

/**
 * Creates the main `awf` action handler bound to a specific option-source
 * resolver (typically `program.getOptionValueSource.bind(program)`).
 *
 * @param getOptionValueSource - Resolves the Commander source for a flag name
 */
export function createMainAction(getOptionValueSource: OptionSourceResolver) {
  return async function mainAction(args: string[], options: Record<string, unknown>): Promise<void> {
  // Require -- separator for passing command arguments
  if (args.length === 0) {
    console.error('Error: No command specified. Use -- to separate command from options.');
    console.error('Example: awf --allow-domains github.com -- curl https://api.github.com');
    process.exit(1);
  }

  // Command argument handling:
  //
  // SINGLE ARGUMENT (complete shell command):
  //   When a single argument is passed, it's treated as a complete shell
  //   command string. This is CRITICAL for preserving shell variables ($HOME,
  //   $(command), etc.) that must expand in the container, not on the host.
  //
  //   Example: awf -- 'echo $HOME'
  //   → args = ['echo $HOME']  (single element)
  //   → Passed as-is: 'echo $HOME'
  //   → Docker Compose: 'echo $$HOME' (escaped for YAML)
  //   → Container shell: 'echo $HOME' (expands to container home)
  //
  // MULTIPLE ARGUMENTS (shell-parsed by user's shell):
  //   When multiple arguments are passed, each is shell-escaped and joined.
  //   This happens when the user doesn't quote the command.
  //
  //   Example: awf -- curl -H "Auth: token" https://api.github.com
  //   → args = ['curl', '-H', 'Auth: token', 'https://api.github.com']
  //   → joinShellArgs(): curl -H 'Auth: token' https://api.github.com
  //
  // Why not use shell-quote library?
  // - shell-quote expands variables on the HOST ($HOME → /home/hostuser)
  // - We need variables to expand in CONTAINER ($HOME → /root or /home/runner)
  // - The $$$$  escaping pattern requires literal $ preservation
  //
  const agentCommand = args.length === 1 ? args[0] : joinShellArgs(args);

  applyConfigFilePrecedence(options as Record<string, unknown>, getOptionValueSource);

  // Parse and validate options
  const logLevel = options.logLevel as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    console.error(`Invalid log level: ${logLevel}`);
    process.exit(1);
  }

  // Validate --anthropic-cache-tail-ttl if provided
  validateAnthropicCacheTailTtl(options.anthropicCacheTailTtl as string | undefined);

  // Model aliases may be injected via config file (not a Commander option),
  // so access through a Record cast with a proper type annotation.
  const modelAliases = (options as Record<string, unknown>).modelAliases as Record<string, string[]> | undefined;
  const maxEffectiveTokensOption = (options as Record<string, unknown>).maxEffectiveTokens as string | number | undefined;
  // Config-file multipliers (already a Record<string, number>)
  const configFileMultipliers =
    (options as Record<string, unknown>).effectiveTokenModelMultipliers as Record<string, number> | undefined;
  // CLI multipliers via --max-model-multiplier (model:multiplier,... format)
  const maxModelMultiplierRaw = (options as Record<string, unknown>).maxModelMultiplier as string | undefined;
  let cliMultipliers: Record<string, number> | undefined;
  if (maxModelMultiplierRaw !== undefined) {
    const parsed = parseModelMultipliersCli(maxModelMultiplierRaw);
    if ('error' in parsed) {
      console.error(`Error: ${parsed.error}`);
      process.exit(1);
    }
    cliMultipliers = parsed.multipliers;
  }
  // CLI flag overrides config-file values for the same model name.
  const effectiveTokenModelMultipliers =
    (configFileMultipliers || cliMultipliers)
      ? { ...configFileMultipliers, ...cliMultipliers }
      : undefined;
  const maxEffectiveTokens = maxEffectiveTokensOption !== undefined ? Number(maxEffectiveTokensOption) : undefined;

  if (maxEffectiveTokens !== undefined && (!Number.isInteger(maxEffectiveTokens) || maxEffectiveTokens <= 0)) {
    console.error('Error: Invalid maxEffectiveTokens value (must be a positive integer)');
    process.exit(1);
  }

  const maxRunsOption = (options as Record<string, unknown>).maxRuns as string | number | undefined;
  const maxRuns = maxRunsOption !== undefined ? Number(maxRunsOption) : undefined;

  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns <= 0)) {
    console.error('Error: Invalid maxRuns value (must be a positive integer)');
    process.exit(1);
  }

  logger.setLevel(logLevel);

  // When DOCKER_HOST points at an external TCP daemon (e.g. workflow-scope DinD),
  // AWF redirects its own docker calls to the local socket automatically.
  // The original DOCKER_HOST value is forwarded into the agent container so the
  // agent workload can still reach the DinD daemon.
  const dockerHostCheck = checkDockerHost();
  if (!dockerHostCheck.valid) {
    logger.warn('⚠️  External DOCKER_HOST detected. AWF will redirect its own Docker calls to the local socket.');
    logger.warn('   The original DOCKER_HOST (and related Docker client env vars) are forwarded into the agent container.');
  }
  const dockerHostPathPrefixResolution = resolveDockerHostPathPrefix(dockerHostCheck, options.dockerHostPathPrefix as string | undefined);
  if (!dockerHostCheck.valid && !dockerHostPathPrefixResolution.dockerHostPathPrefix) {
    logger.warn('⚠️  If your Docker daemon uses a split runner/daemon filesystem, set --docker-host-path-prefix (for example: /host).');
  }

  // Resolve allowed and blocked domains (parse, merge, validate)
  const {
    allowedDomains,
    localhostResult,
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
  } = resolveAllowedDomains(options as Record<string, unknown>);

  const blockedDomains = resolveBlockedDomains(options as Record<string, unknown>);

  // Parse additional environment variables from --env flags
  let additionalEnv: Record<string, string> = {};
  if (options.env && Array.isArray(options.env)) {
    const parsed = parseEnvironmentVariables(options.env as string[]);
    if (!parsed.success) {
      logger.error(`Invalid environment variable format: ${parsed.invalidVar} (expected KEY=VALUE)`);
      process.exit(1);
    }
    additionalEnv = parsed.env;
  }

  // Validate --env-file path if provided
  if (options.envFile) {
    if (!fs.existsSync(options.envFile as string)) {
      logger.error(`--env-file: file not found: ${options.envFile}`);
      process.exit(1);
    }
  }

  // Parse and validate volume mounts from --mount flags
  let volumeMounts: string[] | undefined = undefined;
  if (options.mount && Array.isArray(options.mount) && (options.mount as string[]).length > 0) {
    const parsed = parseVolumeMounts(options.mount as string[]);
    if (!parsed.success) {
      logger.error(`Invalid volume mount: ${parsed.invalidMount}`);
      logger.error(`Reason: ${parsed.reason}`);
      process.exit(1);
    }
    volumeMounts = parsed.mounts;
    logger.debug(`Parsed ${volumeMounts.length} volume mount(s)`);
  }

  // Resolve network configuration (upstream proxy, DNS servers, DNS-over-HTTPS)
  const { upstreamProxy, dnsServers, dnsOverHttps } = resolveNetworkConfig(options as Record<string, unknown>);

  // Parse --allow-urls for SSL Bump mode
  let allowedUrls: string[] | undefined;
  if (options.allowUrls) {
    allowedUrls = parseDomains(options.allowUrls as string);
    if (allowedUrls.length > 0 && !options.sslBump) {
      logger.error('--allow-urls requires --ssl-bump to be enabled');
      process.exit(1);
    }

    // Validate URL patterns for security
    for (const url of allowedUrls) {
      // URL patterns must start with https://
      if (!url.startsWith('https://')) {
        logger.error(`URL patterns must start with https:// (got: ${url})`);
        logger.error('Use --allow-domains for domain-level filtering without SSL Bump');
        process.exit(1);
      }

      // Reject overly broad patterns that would bypass security
      const dangerousPatterns = [
        /^https:\/\/\*$/,           // https://*
        /^https:\/\/\*\.\*$/,       // https://*.*
        /^https:\/\/\.\*$/,         // https://.*
        /^\.\*$/,                   // .*
        /^\*$/,                     // *
        /^https:\/\/[^/]*\*[^/]*$/, // https://*anything* without path
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(url)) {
          logger.error(`URL pattern "${url}" is too broad and would bypass security controls`);
          logger.error('URL patterns must include a specific domain and path, e.g., https://github.com/org/*');
          process.exit(1);
        }
      }

      // Reject characters that could inject Squid config directives or tokens
      if (SQUID_DANGEROUS_CHARS.test(url)) {
        logger.error(`URL pattern contains characters unsafe for Squid config: ${JSON.stringify(url)}`);
        logger.error('URL patterns must not contain whitespace, quotes, semicolons, backticks, hash characters, or null bytes.');
        process.exit(1);
      }

      // Ensure pattern has a path component (not just domain)
      const urlWithoutScheme = url.replace(/^https:\/\//, '');
      if (!urlWithoutScheme.includes('/')) {
        logger.error(`URL pattern "${url}" must include a path component`);
        logger.error('For domain-only filtering, use --allow-domains instead');
        logger.error('Example: https://github.com/myorg/* (includes path)');
        process.exit(1);
      }
    }
  }

  // Validate SSL Bump option
  if (options.sslBump) {
    logger.info('SSL Bump mode enabled - HTTPS content inspection will be performed');
    logger.warn('⚠️  SSL Bump intercepts HTTPS traffic. Only use for trusted workloads.');
  }

  // Log DLP mode
  if (options.enableDlp) {
    logger.info('DLP scanning enabled - outbound requests will be scanned for credential patterns');
  }

  // Validate memory limit
  const memoryLimit = parseMemoryLimit(options.memoryLimit as string);
  if (memoryLimit.error) {
    logger.error(memoryLimit.error);
    process.exit(1);
  }

  // Validate agent image option
  const agentImageResult = processAgentImageOption(options.agentImage as string | undefined, options.buildLocal as boolean);
  if (agentImageResult.error) {
    logger.error(agentImageResult.error);
    process.exit(1);
  }
  if (agentImageResult.infoMessage) {
    logger.info(agentImageResult.infoMessage);
  }
  const agentImage = agentImageResult.agentImage;

  const config: WrapperConfig = {
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
    excludeEnv: options.excludeEnv && (options.excludeEnv as string[]).length > 0 ? options.excludeEnv as string[] : undefined,
    envFile: options.envFile as string | undefined,
    volumeMounts,
    containerWorkDir: options.containerWorkdir as string | undefined,
    dnsServers,
    dnsOverHttps,
    memoryLimit: memoryLimit.value,
    proxyLogsDir: options.proxyLogsDir as string | undefined,
    auditDir: (options.auditDir as string | undefined) || process.env.AWF_AUDIT_DIR,
    sessionStateDir: (options.sessionStateDir as string | undefined) || process.env.AWF_SESSION_STATE_DIR,
    enableHostAccess: options.enableHostAccess as boolean,
    localhostDetected: localhostResult.localhostDetected,
    allowHostPorts: options.allowHostPorts as string | undefined,
    allowHostServicePorts: options.allowHostServicePorts as string | undefined,
    sslBump: options.sslBump as boolean,
    enableDind: options.enableDind as boolean,
    enableDlp: options.enableDlp as boolean,
    allowedUrls,
    enableApiProxy: options.enableApiProxy as boolean,
    enableOpenCode: options.enableOpencode as boolean,
    anthropicAutoCache: options.anthropicAutoCache as boolean,
    anthropicCacheTailTtl: options.anthropicCacheTailTtl as '5m' | '1h' | undefined,
    modelAliases,
    maxEffectiveTokens,
    effectiveTokenModelMultipliers,
    maxRuns,
    enableTokenSteering: options.enableTokenSteering as boolean,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
    copilotApiKey: resolveCopilotApiKey(process.env),
    geminiApiKey: process.env.GEMINI_API_KEY,
    copilotApiTarget: resolvedCopilotApiTarget,
    copilotApiBasePath: resolvedCopilotApiBasePath,
    openaiApiTarget: (options.openaiApiTarget as string | undefined) || process.env.OPENAI_API_TARGET,
    openaiApiBasePath: (options.openaiApiBasePath as string | undefined) || process.env.OPENAI_API_BASE_PATH,
    anthropicApiTarget: (options.anthropicApiTarget as string | undefined) || process.env.ANTHROPIC_API_TARGET,
    anthropicApiBasePath: (options.anthropicApiBasePath as string | undefined) || process.env.ANTHROPIC_API_BASE_PATH,
    geminiApiTarget: (options.geminiApiTarget as string | undefined) || process.env.GEMINI_API_TARGET,
    geminiApiBasePath: (options.geminiApiBasePath as string | undefined) || process.env.GEMINI_API_BASE_PATH,
    difcProxyHost: options.difcProxyHost as string | undefined,
    difcProxyCaCert: options.difcProxyCaCert as string | undefined,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    diagnosticLogs: (options.diagnosticLogs as boolean) || false,
    awfDockerHost: options.dockerHost as string | undefined,
    upstreamProxy,
    dockerHostPathPrefix: dockerHostPathPrefixResolution.dockerHostPathPrefix,
  };

  // Apply --docker-host override for AWF's own container operations.
  // This must be called before startContainers/stopContainers/runAgentCommand.
  if (config.awfDockerHost && !config.awfDockerHost.startsWith('unix://')) {
    logger.error(`❌ --docker-host must be a unix:// socket URI, got: ${config.awfDockerHost}`);
    logger.error('   Example: --docker-host unix:///run/user/1000/docker.sock');
    process.exit(1);
  }
  if (config.dockerHostPathPrefix && !config.dockerHostPathPrefix.startsWith('/')) {
    logger.error(`❌ --docker-host-path-prefix must be an absolute path, got: ${config.dockerHostPathPrefix}`);
    logger.error('   Example: --docker-host-path-prefix /host');
    process.exit(1);
  }
  setAwfDockerHost(config.awfDockerHost);

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
    logger.debug(`Rate limiting: enabled=${rateLimitResult.config.enabled}, rpm=${rateLimitResult.config.rpm}, rph=${rateLimitResult.config.rph}, bytesPm=${rateLimitResult.config.bytesPm}`);
  }

  // Error if rate limit flags are used without --enable-api-proxy
  const rateLimitFlagValidation = validateRateLimitFlags(config.enableApiProxy ?? false, options);
  if (!rateLimitFlagValidation.valid) {
    logger.error(rateLimitFlagValidation.error!);
    process.exit(1);
  }

  // Error if --enable-opencode is used without --enable-api-proxy
  const enableOpenCodeValidation = validateEnableOpenCodeFlag(config.enableApiProxy ?? false, config.enableOpenCode ?? false);
  if (!enableOpenCodeValidation.valid) {
    logger.error(enableOpenCodeValidation.error!);
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
    logger
  );
  if (!servicePortsResult.valid) {
    logger.error(`❌ ${servicePortsResult.error}`);
    process.exit(1);
  }
  config.enableHostAccess = servicePortsResult.enableHostAccess;

  // Validate --allow-host-ports requires --enable-host-access
  const hostPortsValidation = validateAllowHostPorts(config.allowHostPorts, config.enableHostAccess);
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
    const hasHostDomain = allowedDomains.some(d =>
      d === 'host.docker.internal' || d.endsWith('.host.docker.internal')
    );
    if (hasHostDomain) {
      logger.warn('⚠️  Host access enabled with host.docker.internal in allowed domains');
      logger.warn('   Containers can access ANY service running on the host machine');
      logger.warn('   Only use this for trusted workloads (e.g., MCP gateways)');
    }
  }

  // Validate and warn about API proxy configuration
  // Pass booleans (not actual keys) to prevent sensitive data flow to logger
  const apiProxyValidation = validateApiProxyConfig(
    config.enableApiProxy || false,
    !!config.openaiApiKey,
    !!config.anthropicApiKey,
    !!(config.copilotGithubToken || config.copilotApiKey),
    !!config.geminiApiKey
  );

  // Log API proxy status at info level for visibility
  if (config.enableApiProxy) {
    logger.info(`API proxy enabled: OpenAI=${!!config.openaiApiKey}, Anthropic=${!!config.anthropicApiKey}, Copilot=${!!(config.copilotGithubToken || config.copilotApiKey)}, Gemini=${!!config.geminiApiKey}`);
  }

  for (const warning of apiProxyValidation.warnings) {
    logger.warn(warning);
  }
  for (const msg of apiProxyValidation.debugMessages) {
    logger.debug(msg);
  }

  // Warn if custom API targets are not in --allow-domains
  emitApiProxyTargetWarnings(config, allowedDomains, logger.warn.bind(logger));

  // Log CLI proxy status
  emitCliProxyStatusLogs(config, logger.info.bind(logger), logger.warn.bind(logger));

  // Warn if a classic PAT is combined with COPILOT_MODEL (Copilot CLI 1.0.21+ incompatibility)
  const hasCopilotModelInEnvFiles = (envFile: unknown): boolean => {
    const envFiles = Array.isArray(envFile) ? envFile : envFile ? [envFile] : [];
    for (const candidate of envFiles) {
      if (typeof candidate !== 'string' || candidate.trim() === '') continue;
      try {
        const envFilePath = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
        const envFileContents = fs.readFileSync(envFilePath, 'utf8');
        for (const line of envFileContents.split(/\r?\n/)) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith('#')) continue;
          if (/^(?:export\s+)?COPILOT_MODEL\s*=/.test(trimmedLine)) {
            return true;
          }
        }
      } catch {
        // Ignore unreadable env files here; this check is only for a pre-flight warning.
      }
    }
    return false;
  };

  // Warn if a classic PAT is combined with COPILOT_MODEL (Copilot CLI 1.0.21+ incompatibility)
  // Check if COPILOT_MODEL is set via --env/-e flags, host env (when --env-all is active), or --env-file
  const copilotModelFromFlags = !!(additionalEnv['COPILOT_MODEL']);
  const copilotModelInHostEnv = !!(config.envAll && process.env.COPILOT_MODEL);
  const copilotModelInEnvFile = hasCopilotModelInEnvFiles((config as { envFile?: unknown }).envFile);
  warnClassicPATWithCopilotModel(
    config.copilotGithubToken?.startsWith('ghp_') ?? false,
    copilotModelFromFlags || copilotModelInHostEnv || copilotModelInEnvFile,
    logger.warn.bind(logger)
  );

  // Log config with redacted secrets - remove API keys entirely
  // to prevent sensitive data from flowing to logger (CodeQL sensitive data logging)
  const redactedConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'openaiApiKey' || key === 'anthropicApiKey' || key === 'copilotGithubToken' || key === 'copilotApiKey' || key === 'geminiApiKey') continue;
    redactedConfig[key] = key === 'agentCommand' ? redactSecrets(value as string) : value;
  }
  logger.debug('Configuration:', JSON.stringify(redactedConfig, null, 2));
  logger.info(`Allowed domains: ${allowedDomains.join(', ')}`);
  if (blockedDomains.length > 0) {
    logger.info(`Blocked domains: ${blockedDomains.join(', ')}`);
  }
  logger.debug(`DNS servers: ${dnsServers.join(', ')}`);

  let exitCode = 0;
  let containersStarted = false;
  let hostIptablesSetup = false;

  // Handle cleanup on process exit
  const performCleanup = async (signal?: string) => {
    if (signal) {
      logger.info(`Received ${signal}, cleaning up...`);
    }

    // Copy iptables audit BEFORE stopping containers (volumes are destroyed by `docker compose down -v`)
    if (containersStarted) {
      preserveIptablesAudit(config.workDir, config.auditDir);
      await stopContainers(config.workDir, config.keepContainers);
    }

    if (hostIptablesSetup && !config.keepContainers) {
      await cleanupHostIptables();
    }

    if (!config.keepContainers) {
      await cleanup(config.workDir, false, config.proxyLogsDir, config.auditDir, config.sessionStateDir);
      // Note: We don't remove the firewall network here since it can be reused
      // across multiple runs. Cleanup script will handle removal if needed.
    } else {
      logger.info(`Configuration files preserved at: ${config.workDir}`);
      logger.info(`Agent logs available at: ${config.workDir}/agent-logs/`);
      logger.info(`Squid logs available at: ${config.workDir}/squid-logs/`);
      logger.info(`Host iptables rules preserved (--keep-containers enabled)`);
    }
  };

  // Register signal handlers for graceful shutdown
  registerSignalHandlers({
    getContainersStarted: () => containersStarted,
    keepContainers: config.keepContainers,
    fastKillAgentContainer,
    performCleanup,
  });

  try {
    exitCode = await runMainWorkflow(
      config,
      {
        ensureFirewallNetwork,
        setupHostIptables,
        writeConfigs,
        startContainers,
        runAgentCommand,
        collectDiagnosticLogs,
      },
      {
        logger,
        performCleanup,
        onHostIptablesSetup: () => {
          hostIptablesSetup = true;
        },
        onContainersStarted: () => {
          containersStarted = true;
        },
      }
    );

    console.error(`Process exiting with code: ${exitCode}`);
    process.exit(exitCode);
  } catch (error) {
    logger.error('Fatal error:', error);
    await performCleanup();
    console.error(`Process exiting with code: 1`);
    process.exit(1);
  }
  };
}
