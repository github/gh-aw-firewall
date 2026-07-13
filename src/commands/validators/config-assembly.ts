import { WrapperConfig } from '../../types';
import { applyAgentTimeout } from '../../option-parsers';
import { logger } from '../../logger';
import { buildConfig } from '../build-config';
import { LogAndLimitsResult } from './log-and-limits';
import { NetworkOptionsResult } from './network-options';
import { AgentOptionsResult } from './agent-options';
import { validateInfrastructureOptions, applyRateLimitConfig, validateFeatureFlagCompatibility } from './infrastructure-validator';
import { applySecurityMode } from './security-mode';
import { validateHostAccessConfig } from './network-access-validator';
import { validateApiProxyOptions, validateCopilotModelOption } from './api-proxy-validator';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
    maxCacheMisses: logAndLimits.maxCacheMisses,
    resolvedCopilotApiTarget: networkOptions.resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath: networkOptions.resolvedCopilotApiBasePath,
    dockerHostPathPrefix: networkOptions.dockerHostPathPrefixResolution.dockerHostPathPrefix,
  });

  validateInfrastructureOptions(config);
  applySecurityMode(config);
  applyAgentTimeout(options.agentTimeout as string | undefined, config, logger);
  applyRateLimitConfig(config, options);
  validateFeatureFlagCompatibility(config);
  validateHostAccessConfig(config, networkOptions);
  validateApiProxyOptions(config, networkOptions);
  validateCopilotModelOption(config, agentOptions);

  return config;
}
