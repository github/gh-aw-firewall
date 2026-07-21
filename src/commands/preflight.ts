import { logger } from '../logger';
import { loadAwfFileConfig } from '../config-file';
import { mapAwfFileConfigToCliOptions } from '../config-mapper';
import { applyConfigOptionsInPlaceWithCliPrecedence } from '../config-precedence';
import { validateDomainOrPattern } from '../domain-validation';
import { loadAndMergeDomains } from '../rules';
import { parseDomains, parseDomainsFile } from '../domain-utils';
import { processLocalhostKeyword } from '../option-parsers';
import { resolveCopilotApiRouting } from '../copilot-api-resolver';
import { resolveApiTargetsToAllowedDomains } from '../api-proxy-config';
import { resolveTopologyPeerHosts } from '../topology-peers';

/**
 * Resolves the Commander option-value source for a given option name.
 * Injected to decouple the action handler from the global program instance.
 */
type OptionSourceResolver = (optionName: string) => string | undefined;

/**
 * The result produced by {@link resolveAllowedDomains}.
 */
interface AllowedDomainsResult {
  allowedDomains: string[];
  localhostResult: ReturnType<typeof processLocalhostKeyword>;
  resolvedCopilotApiTarget: string | undefined;
  resolvedCopilotApiBasePath: string | undefined;
}

/**
 * Loads the AWF config file and applies its values to `options` in-place,
 * giving CLI flags precedence over config-file values.
 *
 * Does nothing when `options.config` is not set.
 * Calls `process.exit(1)` on parse errors so the caller need not handle them.
 */
export function applyConfigFilePrecedence(
  options: Record<string, unknown>,
  getOptionValueSource: OptionSourceResolver
): void {
  if (!options.config) return;
  try {
    const fileConfig = loadAwfFileConfig(options.config as string);
    const fileDerivedOptions = mapAwfFileConfigToCliOptions(fileConfig);
    applyConfigOptionsInPlaceWithCliPrecedence(
      options,
      fileDerivedOptions,
      // Commander marks explicit user flags with source "cli".
      // We only apply config values when a flag was not explicitly provided.
      (optionName: string) => getOptionValueSource(optionName) === 'cli'
    );
  } catch (error) {
    logger.error(`Error loading --config: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/**
 * Parses and merges domain options from CLI flags and ruleset files.
 *
 * Calls `process.exit(1)` on parse/merge failures.
 */
export function parseDomainOptions(options: Record<string, unknown>): string[] {
  let allowedDomains: string[] = [];

  if (options.allowDomains) {
    allowedDomains = parseDomains(options.allowDomains as string);
  }

  if (options.allowDomainsFile) {
    try {
      const fileDomainsArray = parseDomainsFile(options.allowDomainsFile as string);
      allowedDomains.push(...fileDomainsArray);
    } catch (error) {
      logger.error(`Failed to read domains file: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  if (options.rulesetFile && Array.isArray(options.rulesetFile) && options.rulesetFile.length > 0) {
    try {
      allowedDomains = loadAndMergeDomains(options.rulesetFile as string[], allowedDomains);
    } catch (error) {
      logger.error(`Failed to load ruleset file: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  return allowedDomains;
}

/**
 * Validates allowed domain patterns.
 *
 * Calls `process.exit(1)` on validation failures.
 */
export function validateAllowedDomains(domains: string[]): void {
  for (const domain of domains) {
    try {
      validateDomainOrPattern(domain);
    } catch (error) {
      logger.error(`Invalid domain or pattern: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }
}

/**
 * Resolves the final set of allowed domains by:
 * 1. Parsing `--allow-domains` and `--allow-domains-file` flags
 * 2. Merging `--ruleset-file` YAML domains
 * 3. Processing the `localhost` keyword
 * 4. Resolving Copilot / OpenAI / Anthropic / Gemini API-target domains
 * 5. Validating each domain pattern
 *
 * Side-effects: may mutate `options.enableHostAccess` and `options.allowHostPorts`
 * when the `localhost` keyword is detected.
 *
 * Calls `process.exit(1)` on any validation failure.
 */
export function resolveAllowedDomains(options: Record<string, unknown>): AllowedDomainsResult {
  let allowedDomains = parseDomainOptions(options);

  // Log when no domains are specified (all network access will be blocked)
  if (allowedDomains.length === 0) {
    logger.debug('No allowed domains specified - all network access will be blocked');
  }

  // Remove duplicates (in case domains appear in both sources)
  allowedDomains = [...new Set(allowedDomains)];

  // Handle special "localhost" keyword for Playwright testing
  // This makes localhost testing work out of the box without requiring manual configuration
  const localhostResult = processLocalhostKeyword(
    allowedDomains,
    (options.enableHostAccess as boolean) || false,
    options.allowHostPorts as string | undefined
  );

  if (localhostResult.localhostDetected) {
    allowedDomains = localhostResult.allowedDomains;

    // Auto-enable host access
    if (localhostResult.shouldEnableHostAccess) {
      options.enableHostAccess = true;
      logger.warn('⚠️  Security warning: localhost keyword enables host access - agent can reach services on your machine');
      logger.info('ℹ️  localhost keyword detected - automatically enabling host access');
    }

    // Auto-configure common dev ports if not already specified
    if (localhostResult.defaultPorts) {
      options.allowHostPorts = localhostResult.defaultPorts;
      logger.info('ℹ️  localhost keyword detected - allowing common development ports (3000, 4200, 5173, 8080, etc.)');
      logger.info('   Use --allow-host-ports to customize the port list');
    }
  }

  const {
    copilotApiTarget: resolvedCopilotApiTarget,
    copilotApiBasePath: resolvedCopilotApiBasePath,
  } = resolveCopilotApiRouting(
    { copilotApiTarget: options.copilotApiTarget as string | undefined },
    process.env
  );

  // Automatically add API target values to allowlist when specified
  // This ensures that when engine.api-target is set in GitHub Agentic Workflows,
  // the target domain is automatically accessible through the firewall
  resolveApiTargetsToAllowedDomains(
    {
      copilotApiTarget: resolvedCopilotApiTarget,
      openaiApiTarget: options.openaiApiTarget as string | undefined,
      anthropicApiTarget: options.anthropicApiTarget as string | undefined,
      geminiApiTarget: options.geminiApiTarget as string | undefined,
    },
    allowedDomains,
    process.env,
    logger.debug.bind(logger)
  );

  // In network-isolation (topology) mode, automatically add trusted topology
  // peer hostnames to the Squid allowed-domain ACL. NO_PROXY is also set for
  // these peers (in proxy-environment.ts) so that proxy-aware clients
  // (undici/rmcp) connect directly; adding them here ensures Squid does not
  // block requests from tools that honour HTTP(S)_PROXY but ignore NO_PROXY.
  //
  // This covers the standard-port (80/443) path. Non-standard MCP ports (e.g.
  // http://awmg-mcpg:8080) and Squid's DNS resolution of these Docker-only
  // hostnames are handled separately via SquidConfig.topologyPeers and the
  // squid-proxy extra_hosts patch (see config-writer.ts / topology.ts).
  //
  // NOTE ON SQUID SEMANTICS: these names are emitted as dstdomain ACL entries
  // via formatDomainForSquid, which prepends a leading dot (e.g. "awmg-mcpg" ->
  // ".awmg-mcpg"). Squid therefore matches the host itself *and* any subdomain
  // (*.awmg-mcpg). This is safe for internal Docker hostnames (a bare label
  // like "github" matches host "github", not "github.com"), but operators
  // should avoid topology names that collide with trusted public labels.
  for (const peer of resolveTopologyPeerHosts(options)) {
    if (!allowedDomains.includes(peer)) {
      allowedDomains.push(peer);
      logger.debug(`Network-isolation: auto-allowing topology peer "${peer}" in Squid ACL`);
    }
  }

  validateAllowedDomains(allowedDomains);

  return { allowedDomains, localhostResult, resolvedCopilotApiTarget, resolvedCopilotApiBasePath };
}

/**
 * Resolves the final set of blocked domains by parsing `--block-domains`
 * and `--block-domains-file` flags and validating each pattern.
 *
 * Calls `process.exit(1)` on any validation failure.
 */
export function resolveBlockedDomains(options: Record<string, unknown>): string[] {
  let blockedDomains: string[] = [];

  // Parse blocked domains from command-line flag if provided
  if (options.blockDomains) {
    blockedDomains = parseDomains(options.blockDomains as string);
  }

  // Parse blocked domains from file if provided
  if (options.blockDomainsFile) {
    try {
      const fileBlockedDomainsArray = parseDomainsFile(options.blockDomainsFile as string);
      blockedDomains.push(...fileBlockedDomainsArray);
    } catch (error) {
      logger.error(`Failed to read blocked domains file: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  // Remove duplicates from blocked domains
  blockedDomains = [...new Set(blockedDomains)];

  // Validate all blocked domains and patterns
  for (const domain of blockedDomains) {
    try {
      validateDomainOrPattern(domain);
    } catch (error) {
      logger.error(`Invalid blocked domain or pattern: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  return blockedDomains;
}
