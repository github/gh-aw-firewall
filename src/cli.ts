#!/usr/bin/env node

// Re-export domain utilities (extracted to domain-utils.ts)
export {
  parseDomains,
  parseDomainsFile,
  isValidIPv4,
  isValidIPv6,
  AGENT_IMAGE_PRESETS,
  isAgentImagePreset,
  validateAgentImage,
  processAgentImageOption,
  DEFAULT_OPENAI_API_TARGET,
  DEFAULT_ANTHROPIC_API_TARGET,
  DEFAULT_GEMINI_API_TARGET,
  DEFAULT_COPILOT_API_TARGET,
} from './domain-utils';

// Re-export API proxy config (extracted to api-proxy-config.ts)
export {
  validateApiProxyConfig,
  validateAnthropicCacheTailTtl,
  validateApiTargetInAllowedDomains,
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
  extractGhecDomainsFromServerUrl,
  extractGhesDomainsFromEngineApiTarget,
  resolveApiTargetsToAllowedDomains,
} from './api-proxy-config';

// Re-export option parsers (extracted to option-parsers.ts)
export {
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableOpenCodeFlag,
  collectRulesetFile,
  hasRateLimitOptions,
  validateSkipPullWithBuildLocal,
  validateAllowHostPorts,
  validateAllowHostServicePorts,
  applyHostServicePortsConfig,
  parseMemoryLimit,
  parseAgentTimeout,
  applyAgentTimeout,
  checkDockerHost,
  resolveDockerHostPathPrefix,
  parseDnsServers,
  parseDnsOverHttps,
  processLocalhostKeyword,
  escapeShellArg,
  joinShellArgs,
  parseEnvironmentVariables,
  parseVolumeMounts,
  formatItem,
} from './option-parsers';

/**
 * Default DNS servers (Google Public DNS)
 * @deprecated Import from dns-resolver.ts instead
 */
export { DEFAULT_DNS_SERVERS } from './dns-resolver';

// Re-export for backwards compatibility (used by cli.test.ts and other consumers)
export {
  resolveCopilotApiKey,
  deriveCopilotApiTargetFromProviderBaseUrl,
  deriveCopilotApiBasePathFromProviderBaseUrl,
  resolveCopilotApiRouting,
} from './copilot-api-resolver';

import { program } from './cli-options';
import { createMainAction } from './commands/main-action';
import { registerSubcommands, validateFormat, handlePredownloadAction } from './commands/subcommands';

// Re-export the program instance and subcommand utilities
export { program, validateFormat, handlePredownloadAction };

program.action(createMainAction(program.getOptionValueSource.bind(program)));
registerSubcommands(program);

// Only parse arguments if this file is run directly (not imported as a module)
if (require.main === module) {
  program.parse();
}
