#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WrapperConfig, LogLevel } from './types';
import { logger } from './logger';
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
} from './docker-manager';
import {
  ensureFirewallNetwork,
  setupHostIptables,
  cleanupHostIptables,
} from './host-iptables';
import { runMainWorkflow } from './cli-workflow';
import { redactSecrets } from './redact-secrets';
import { validateDomainOrPattern, SQUID_DANGEROUS_CHARS } from './domain-patterns';
import { loadAndMergeDomains } from './rules';
import { detectHostDnsServers } from './dns-resolver';
import { detectUpstreamProxy, parseProxyUrl, parseNoProxy } from './upstream-proxy';
import { loadAwfFileConfig, mapAwfFileConfigToCliOptions, applyConfigOptionsInPlaceWithCliPrecedence } from './config-file';
import { OutputFormat } from './types';
import { version } from '../package.json';

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
export type { AgentImageResult } from './domain-utils';

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
export type { ApiProxyValidationResult } from './api-proxy-config';

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
  parseDnsServers,
  parseDnsOverHttps,
  processLocalhostKeyword,
  escapeShellArg,
  joinShellArgs,
  parseEnvironmentVariables,
  parseVolumeMounts,
  formatItem,
} from './option-parsers';
export type { FlagValidationResult, LocalhostProcessingResult } from './option-parsers';

/**
 * Default DNS servers (Google Public DNS)
 * @deprecated Import from dns-resolver.ts instead
 */
export { DEFAULT_DNS_SERVERS } from './dns-resolver';

// Import functions used directly in this file
import { parseDomains, parseDomainsFile } from './domain-utils';
import {
  DEFAULT_OPENAI_API_TARGET,
  DEFAULT_ANTHROPIC_API_TARGET,
  DEFAULT_COPILOT_API_TARGET,
  DEFAULT_GEMINI_API_TARGET,
} from './domain-utils';
import {
  validateApiProxyConfig,
  validateAnthropicCacheTailTtl,
  emitApiProxyTargetWarnings,
  emitCliProxyStatusLogs,
  warnClassicPATWithCopilotModel,
  resolveApiTargetsToAllowedDomains,
} from './api-proxy-config';
import {
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableOpenCodeFlag,
  collectRulesetFile,
  hasRateLimitOptions,
  validateSkipPullWithBuildLocal,
  validateAllowHostPorts,
  applyHostServicePortsConfig,
  parseMemoryLimit,
  applyAgentTimeout,
  checkDockerHost,
  parseDnsServers,
  parseDnsOverHttps,
  processLocalhostKeyword,
  escapeShellArg,
  joinShellArgs,
  parseEnvironmentVariables,
  parseVolumeMounts,
  formatItem,
} from './option-parsers';
import { processAgentImageOption } from './domain-utils';

export const program = new Command();

// Option group markers used by the custom help formatter to insert section headers.
// Each key is the long flag name of the first option in a group.
const optionGroupHeaders: Record<string, string> = {
  'config': 'Configuration:',
  'allow-domains': 'Domain Filtering:',
  'build-local': 'Image Management:',
  'env': 'Container Configuration:',
  'dns-servers': 'Network & Security:',
  'upstream-proxy': 'Network & Security:',
  'enable-api-proxy': 'API Proxy:',
  'log-level': 'Logging & Debug:',
};

program
  .name('awf')
  .description('Network firewall for agentic workflows with domain whitelisting')
  .version(version)
  .configureHelp({
    formatHelp(cmd, helper): string {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = (helper as unknown as { helpWidth?: number }).helpWidth ?? 80;
      const itemIndent = 2;
      const itemSep = 2;

      const output: string[] = [];

      // Usage line
      const usage = helper.commandUsage(cmd);
      output.push(`Usage: ${usage}`);

      const desc = helper.commandDescription(cmd);
      if (desc) {
        output.push('');
        output.push(desc);
      }

      // Arguments
      const args = helper.visibleArguments(cmd);
      if (args.length > 0) {
        output.push('');
        output.push('Arguments:');
        for (const arg of args) {
          const term = helper.argumentTerm(arg);
          const argDesc = helper.argumentDescription(arg);
          output.push(formatItem(term, argDesc, termWidth, itemIndent, itemSep, helpWidth));
        }
      }

      // Options with group headers
      const options = helper.visibleOptions(cmd);
      if (options.length > 0) {
        output.push('');
        output.push('Options:');
        for (const opt of options) {
          const flags = helper.optionTerm(opt);
          const optDesc = helper.optionDescription(opt);
          const longFlag = opt.long?.replace(/^--/, '');
          if (longFlag && optionGroupHeaders[longFlag]) {
            output.push('');
            output.push(`  ${optionGroupHeaders[longFlag]}`);
          }
          output.push(formatItem(flags, optDesc, termWidth, itemIndent + 2, itemSep, helpWidth));
        }
      }

      return output.join('\n') + '\n';
    }
  })

  .option(
    '--config <path>',
    'Path to AWF JSON/YAML config file (use "-" to read from stdin)'
  )

  // -- Domain Filtering --
  .option(
    '-d, --allow-domains <domains>',
    'Comma-separated list of allowed domains. Supports wildcards and protocol prefixes:\n' +
    '                                       github.com         - exact domain + subdomains (HTTP & HTTPS)\n' +
    '                                       *.github.com       - any subdomain of github.com\n' +
    '                                       api-*.example.com  - api-* subdomains\n' +
    '                                       https://secure.com - HTTPS only\n' +
    '                                       http://legacy.com  - HTTP only\n' +
    '                                       localhost          - auto-configure for local testing (Playwright, etc.)'
  )
  .option(
    '--allow-domains-file <path>',
    'Path to file with allowed domains (one per line, supports # comments)'
  )
  .option(
    '--ruleset-file <path>',
    'YAML rule file for domain allowlisting (repeatable). Schema: version: 1, rules: [{domain, subdomains}]',
    collectRulesetFile,
    []
  )
  .option(
    '--block-domains <domains>',
    'Comma-separated blocked domains (overrides allow list). Supports wildcards.'
  )
  .option(
    '--block-domains-file <path>',
    'Path to file with blocked domains (one per line, supports # comments)'
  )
  .option(
    '--ssl-bump',
    'Enable SSL Bump for HTTPS content inspection (allows URL path filtering)',
    false
  )
  .option(
    '--allow-urls <urls>',
    'Comma-separated allowed URL patterns for HTTPS (requires --ssl-bump).\n' +
    '                                       Supports wildcards: https://github.com/myorg/*'
  )

  // -- Image Management --
  .option(
    '-b, --build-local',
    'Build containers locally instead of using GHCR images',
    false
  )
  .option(
    '--agent-image <value>',
    'Agent container image (default: "default")\n' +
    '                                       Presets (pre-built, fast):\n' +
    '                                         default  - Minimal ubuntu:22.04 (~200MB)\n' +
    '                                         act      - GitHub Actions parity (~2GB)\n' +
    '                                       Custom base images (requires --build-local):\n' +
    '                                         ubuntu:XX.XX\n' +
    '                                         ghcr.io/catthehacker/ubuntu:runner-XX.XX\n' +
    '                                         ghcr.io/catthehacker/ubuntu:full-XX.XX'
  )
  .option(
    '--image-registry <registry>',
    'Container image registry',
    'ghcr.io/github/gh-aw-firewall'
  )
  .option(
    '--image-tag <tag>',
    'Container image tag (applies to squid, agent/agent-act, api-proxy, and cli-proxy when enabled)\n' +
    '                                       Optional digest metadata format:\n' +
    '                                         <tag>,squid=sha256:...,agent=sha256:...,agent-act=sha256:...,api-proxy=sha256:...,cli-proxy=sha256:...\n' +
    '                                       Image name varies by --agent-image preset:\n' +
    '                                         default → agent:<tag>\n' +
    '                                         act     → agent-act:<tag>',
    'latest'
  )
  .option(
    '--skip-pull',
    'Use local images without pulling from registry (requires pre-downloaded images)',
    false
  )
  .option(
    '--docker-host <socket>',
    'Docker socket for AWF\'s own containers (default: auto-detect from DOCKER_HOST env).\n' +
    '                                       Use when Docker is at a non-standard path.\n' +
    '                                       Example: unix:///run/user/1000/docker.sock'
  )

  // -- Container Configuration --
  .option(
    '-e, --env <KEY=VALUE>',
    'Environment variable for the container (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
    []
  )
  .option(
    '--env-all',
    'Pass all host environment variables to container (excludes system vars like PATH)',
    false
  )
  .option(
    '--exclude-env <name>',
    'Exclude a specific environment variable from --env-all passthrough (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
    []
  )
  .option(
    '--env-file <path>',
    'Read environment variables from a file (KEY=VALUE format, one per line)'
  )
  .option(
    '-v, --mount <host_path:container_path[:mode]>',
    'Volume mount (repeatable). Format: host_path:container_path[:ro|rw]',
    (value: string, previous: string[] = []) => [...previous, value],
    []
  )
  .option(
    '--container-workdir <dir>',
    'Working directory inside the container'
  )
  .option(
    '--memory-limit <limit>',
    'Memory limit for the agent container (e.g., 4g, 6g, 8g, 512m). Default: 6g',
    '6g'
  )
  .option(
    '--tty',
    'Allocate a pseudo-TTY (required for interactive tools like Claude Code)',
    false
  )

  // -- Network & Security --
  .option(
    '--dns-servers <servers>',
    'Comma-separated trusted DNS servers (auto-detected from host if omitted)'
  )
  .option(
    '--dns-over-https [resolver-url]',
    'Enable DNS-over-HTTPS via sidecar proxy (default: https://dns.google/dns-query)'
  )
  .option(
    '--upstream-proxy <url>',
    'Upstream (corporate) proxy URL for Squid to chain through.\n' +
    '                                       Auto-detected from host https_proxy/http_proxy if not set.\n' +
    '                                       Example: http://proxy.corp.com:3128'
  )
  .option(
    '--enable-host-access',
    'Enable access to host services via host.docker.internal',
    false
  )
  .option(
    '--allow-host-ports <ports>',
    'Ports/ranges to allow with --enable-host-access (default: 80,443).\n' +
    '                                       Example: 3000,8080 or 3000-3010,8000-8090'
  )
  .option(
    '--allow-host-service-ports <ports>',
    'Ports to allow ONLY to host gateway (for GitHub Actions services).\n' +
    '                                       Bypasses dangerous port restrictions. Auto-enables host access.\n' +
    '                                       WARNING: Allowing port 22 grants SSH access to the host.\n' +
    '                                       Example: 5432,6379'
  )

  .option(
    '--enable-dind',
    'Enable Docker-in-Docker by exposing host Docker socket.\n' +
    '                                       WARNING: allows firewall bypass via docker run',
    false
  )
  .option(
    '--enable-dlp',
    'Enable DLP (Data Loss Prevention) scanning to block credential\n' +
    '                                       exfiltration in outbound request URLs.',
    false
  )

  // -- API Proxy --
  .option(
    '--enable-api-proxy',
    'Enable API proxy sidecar for secure credential injection.\n' +
    '                                       Supports OpenAI (Codex) and Anthropic (Claude) APIs.',
    false
  )
  .option(
    '--copilot-api-target <host>',
    'Target hostname for Copilot API requests (default: api.githubcopilot.com)',
  )
  .option(
    '--openai-api-target <host>',
    'Target hostname for OpenAI API requests (default: api.openai.com)',
  )
  .option(
    '--openai-api-base-path <path>',
    'Base path prefix for OpenAI API requests (e.g. /serving-endpoints for Databricks)',
  )
  .option(
    '--anthropic-api-target <host>',
    'Target hostname for Anthropic API requests (default: api.anthropic.com)',
  )
  .option(
    '--anthropic-api-base-path <path>',
    'Base path prefix for Anthropic API requests (e.g. /anthropic)',
  )
  .option(
    '--gemini-api-target <host>',
    'Target hostname for Gemini API requests (default: generativelanguage.googleapis.com)',
  )
  .option(
    '--gemini-api-base-path <path>',
    'Base path prefix for Gemini API requests',
  )
  .option(
    '--enable-opencode',
    'Enable OpenCode API proxy listener on port 10004 (requires --enable-api-proxy).\n' +
    '                                       Only start this when the workflow uses the OpenCode engine.',
    false
  )
  .option(
    '--anthropic-auto-cache',
    'Enable Anthropic prompt-cache optimizations in the API proxy (requires --enable-api-proxy).\n' +
    '                                       Injects cache breakpoints on tools/system/messages, upgrades TTL to 1h,\n' +
    '                                       and strips ANSI codes — typically saves ~90% on Anthropic API input costs.',
    false
  )
  .option(
    '--anthropic-cache-tail-ttl <5m|1h>',
    'TTL for the rolling-tail cache breakpoint when --anthropic-auto-cache is enabled.\n' +
    '                                       Use "5m" (default) for fast interactive sessions, "1h" for long agentic tasks.',
  )
  .option(
    '--rate-limit-rpm <n>',
    'Max requests per minute per provider (requires --enable-api-proxy)',
  )
  .option(
    '--rate-limit-rph <n>',
    'Max requests per hour per provider (requires --enable-api-proxy)',
  )
  .option(
    '--rate-limit-bytes-pm <n>',
    'Max request bytes per minute per provider (requires --enable-api-proxy)',
  )
  .option(
    '--no-rate-limit',
    'Disable rate limiting in the API proxy (requires --enable-api-proxy)',
  )

  // -- CLI Proxy (external DIFC proxy) --
  .option(
    '--difc-proxy-host <host:port>',
    'Connect to an external DIFC proxy (mcpg) at host:port.\n' +
    '                                       Enables the CLI proxy sidecar that routes gh commands through the DIFC proxy.\n' +
    '                                       The DIFC proxy must be started externally (e.g., by the gh-aw compiler).',
  )
  .option(
    '--difc-proxy-ca-cert <path>',
    'Path to TLS CA cert written by the external DIFC proxy.\n' +
    '                                       Recommended when --difc-proxy-host is set for TLS verification.',
  )
  // -- Logging & Debug --
  .option(
    '--log-level <level>',
    'Log level: debug, info, warn, error',
    'info'
  )
  .option(
    '-k, --keep-containers',
    'Keep containers running after command exits',
    false
  )
  .option(
    '--agent-timeout <minutes>',
    'Maximum time in minutes for the agent command to run (default: no limit)',
  )
  .option(
    '--work-dir <dir>',
    'Working directory for temporary files',
    path.join(os.tmpdir(), `awf-${Date.now()}`)
  )
  .option(
    '--proxy-logs-dir <path>',
    'Directory to save Squid proxy access.log'
  )
  .option(
    '--audit-dir <path>',
    'Directory for firewall audit artifacts (configs, policy manifest, iptables state)'
  )
  .option(
    '--session-state-dir <path>',
    'Directory to save Copilot CLI session state (events.jsonl, session data)'
  )
  .option(
    '--diagnostic-logs',
    'Collect container logs, exit state, and sanitized config on non-zero exit.\n' +
    '                                       Useful for debugging container startup failures (e.g. Squid crashes in DinD).\n' +
    '                                       Written to <workDir>/diagnostics/ (or <audit-dir>/diagnostics/ when set).',
    false
  )
  .argument('[args...]', 'Command and arguments to execute (use -- to separate from options)')
  .action(async (args: string[], options) => {
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

    if (options.config) {
      try {
        const fileConfig = loadAwfFileConfig(options.config);
        const fileDerivedOptions = mapAwfFileConfigToCliOptions(fileConfig);
        applyConfigOptionsInPlaceWithCliPrecedence(
          options as Record<string, unknown>,
          fileDerivedOptions,
          // Commander marks explicit user flags with source "cli".
          // We only apply config values when a flag was not explicitly provided.
          (optionName: string) => program.getOptionValueSource(optionName) === 'cli'
        );
      } catch (error) {
        console.error(`Error loading --config: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    }

    // Parse and validate options
    const logLevel = options.logLevel as LogLevel;
    if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
      console.error(`Invalid log level: ${logLevel}`);
      process.exit(1);
    }

    // Validate --anthropic-cache-tail-ttl if provided
    validateAnthropicCacheTailTtl(options.anthropicCacheTailTtl);

    // Model aliases may be injected via config file (not a Commander option),
    // so access through a Record cast with a proper type annotation.
    const modelAliases = (options as Record<string, unknown>).modelAliases as Record<string, string[]> | undefined;

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

    // Parse domains from both --allow-domains flag and --allow-domains-file
    let allowedDomains: string[] = [];

    // Parse domains from command-line flag if provided
    if (options.allowDomains) {
      allowedDomains = parseDomains(options.allowDomains);
    }

    // Parse domains from file if provided
    if (options.allowDomainsFile) {
      try {
        const fileDomainsArray = parseDomainsFile(options.allowDomainsFile);
        allowedDomains.push(...fileDomainsArray);
      } catch (error) {
        logger.error(`Failed to read domains file: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Merge domains from --ruleset-file YAML files
    if (options.rulesetFile && Array.isArray(options.rulesetFile) && options.rulesetFile.length > 0) {
      try {
        allowedDomains = loadAndMergeDomains(options.rulesetFile, allowedDomains);
      } catch (error) {
        logger.error(`Failed to load ruleset file: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

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
      options.enableHostAccess || false,
      options.allowHostPorts
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

    // Automatically add API target values to allowlist when specified
    // This ensures that when engine.api-target is set in GitHub Agentic Workflows,
    // the target domain is automatically accessible through the firewall
    resolveApiTargetsToAllowedDomains(options, allowedDomains, process.env, logger.debug.bind(logger));

    // Validate all domains and patterns
    for (const domain of allowedDomains) {
      try {
        validateDomainOrPattern(domain);
      } catch (error) {
        logger.error(`Invalid domain or pattern: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Parse blocked domains from both --block-domains flag and --block-domains-file
    let blockedDomains: string[] = [];

    // Parse blocked domains from command-line flag if provided
    if (options.blockDomains) {
      blockedDomains = parseDomains(options.blockDomains);
    }

    // Parse blocked domains from file if provided
    if (options.blockDomainsFile) {
      try {
        const fileBlockedDomainsArray = parseDomainsFile(options.blockDomainsFile);
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

    // Parse additional environment variables from --env flags
    let additionalEnv: Record<string, string> = {};
    if (options.env && Array.isArray(options.env)) {
      const parsed = parseEnvironmentVariables(options.env);
      if (!parsed.success) {
        logger.error(`Invalid environment variable format: ${parsed.invalidVar} (expected KEY=VALUE)`);
        process.exit(1);
      }
      additionalEnv = parsed.env;
    }

    // Validate --env-file path if provided
    if (options.envFile) {
      if (!fs.existsSync(options.envFile)) {
        logger.error(`--env-file: file not found: ${options.envFile}`);
        process.exit(1);
      }
    }

    // Parse and validate volume mounts from --mount flags
    let volumeMounts: string[] | undefined = undefined;
    if (options.mount && Array.isArray(options.mount) && options.mount.length > 0) {
      const parsed = parseVolumeMounts(options.mount);
      if (!parsed.success) {
        logger.error(`Invalid volume mount: ${parsed.invalidMount}`);
        logger.error(`Reason: ${parsed.reason}`);
        process.exit(1);
      }
      volumeMounts = parsed.mounts;
      logger.debug(`Parsed ${volumeMounts.length} volume mount(s)`);
    }

    // Parse and validate DNS servers (auto-detect if not explicitly provided)
    let dnsServers: string[];
    if (options.dnsServers) {
      try {
        dnsServers = parseDnsServers(options.dnsServers);
      } catch (error) {
        logger.error(`Invalid DNS servers: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    } else {
      dnsServers = detectHostDnsServers(logger);
    }

    // Parse and validate --dns-over-https
    let dnsOverHttps: string | undefined;
    const dohResult = parseDnsOverHttps(options.dnsOverHttps);
    if (dohResult && 'error' in dohResult) {
      logger.error(dohResult.error);
      process.exit(1);
    } else if (dohResult) {
      dnsOverHttps = dohResult.url;
      logger.info(`DNS-over-HTTPS enabled: ${dnsOverHttps}`);
    }

    // Detect or parse upstream proxy configuration
    let upstreamProxy: import('./types').UpstreamProxyConfig | undefined;
    if (options.upstreamProxy) {
      // Explicit --upstream-proxy flag
      try {
        const { host, port } = parseProxyUrl(options.upstreamProxy);
        // Parse no_proxy from environment even when --upstream-proxy is explicit
        const noProxyStr = (process.env.no_proxy || process.env.NO_PROXY || '').trim();
        const noProxy = noProxyStr ? parseNoProxy(noProxyStr) : [];
        upstreamProxy = { host, port, ...(noProxy.length > 0 ? { noProxy } : {}) };
        logger.info(`Upstream proxy (explicit): ${host}:${port}`);
      } catch (error) {
        logger.error(`Invalid --upstream-proxy: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    } else {
      // Auto-detect from host environment variables
      try {
        upstreamProxy = detectUpstreamProxy();
      } catch (error) {
        logger.error(`Upstream proxy auto-detection failed: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Parse --allow-urls for SSL Bump mode
    let allowedUrls: string[] | undefined;
    if (options.allowUrls) {
      allowedUrls = parseDomains(options.allowUrls);
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
    const memoryLimit = parseMemoryLimit(options.memoryLimit);
    if (memoryLimit.error) {
      logger.error(memoryLimit.error);
      process.exit(1);
    }

    // Validate agent image option
    const agentImageResult = processAgentImageOption(options.agentImage, options.buildLocal);
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
      keepContainers: options.keepContainers,
      tty: options.tty || false,
      workDir: options.workDir,
      buildLocal: options.buildLocal,
      skipPull: options.skipPull,
      agentImage,
      imageRegistry: options.imageRegistry,
      imageTag: options.imageTag,
      additionalEnv: Object.keys(additionalEnv).length > 0 ? additionalEnv : undefined,
      envAll: options.envAll,
      excludeEnv: options.excludeEnv && options.excludeEnv.length > 0 ? options.excludeEnv : undefined,
      envFile: options.envFile,
      volumeMounts,
      containerWorkDir: options.containerWorkdir,
      dnsServers,
      dnsOverHttps,
      memoryLimit: memoryLimit.value,
      proxyLogsDir: options.proxyLogsDir,
      auditDir: options.auditDir || process.env.AWF_AUDIT_DIR,
      sessionStateDir: options.sessionStateDir || process.env.AWF_SESSION_STATE_DIR,
      enableHostAccess: options.enableHostAccess,
      localhostDetected: localhostResult.localhostDetected,
      allowHostPorts: options.allowHostPorts,
      allowHostServicePorts: options.allowHostServicePorts,
      sslBump: options.sslBump,
      enableDind: options.enableDind,
      enableDlp: options.enableDlp,
      allowedUrls,
      enableApiProxy: options.enableApiProxy,
      enableOpenCode: options.enableOpencode,
      anthropicAutoCache: options.anthropicAutoCache,
      anthropicCacheTailTtl: options.anthropicCacheTailTtl,
      modelAliases,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
      copilotApiKey: process.env.COPILOT_API_KEY,
      geminiApiKey: process.env.GEMINI_API_KEY,
      copilotApiTarget: options.copilotApiTarget || process.env.COPILOT_API_TARGET,
      openaiApiTarget: options.openaiApiTarget || process.env.OPENAI_API_TARGET,
      openaiApiBasePath: options.openaiApiBasePath || process.env.OPENAI_API_BASE_PATH,
      anthropicApiTarget: options.anthropicApiTarget || process.env.ANTHROPIC_API_TARGET,
      anthropicApiBasePath: options.anthropicApiBasePath || process.env.ANTHROPIC_API_BASE_PATH,
      geminiApiTarget: options.geminiApiTarget || process.env.GEMINI_API_TARGET,
      geminiApiBasePath: options.geminiApiBasePath || process.env.GEMINI_API_BASE_PATH,
      difcProxyHost: options.difcProxyHost,
      difcProxyCaCert: options.difcProxyCaCert,
      githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      diagnosticLogs: options.diagnosticLogs || false,
      awfDockerHost: options.dockerHost,
      upstreamProxy,
    };

    // Apply --docker-host override for AWF's own container operations.
    // This must be called before startContainers/stopContainers/runAgentCommand.
    if (config.awfDockerHost && !config.awfDockerHost.startsWith('unix://')) {
      logger.error(`❌ --docker-host must be a unix:// socket URI, got: ${config.awfDockerHost}`);
      logger.error('   Example: --docker-host unix:///run/user/1000/docker.sock');
      process.exit(1);
    }
    setAwfDockerHost(config.awfDockerHost);

    // Parse and validate --agent-timeout
    applyAgentTimeout(options.agentTimeout, config, logger);

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

    // Register signal handlers
    // Fast-kill the agent container immediately so it cannot outlive the awf
    // process. GH Actions sends SIGTERM then SIGKILL ~10 s later; the full
    // docker compose down in performCleanup() is too slow to finish in that
    // window, leaving the container running as an orphan.
    /* istanbul ignore next -- signal handlers cannot be unit-tested */
    process.on('SIGINT', async () => {
      if (containersStarted && !config.keepContainers) {
        await fastKillAgentContainer();
      }
      await performCleanup('SIGINT');
      console.error(`Process exiting with code: 130`);
      process.exit(130); // Standard exit code for SIGINT
    });

    /* istanbul ignore next -- signal handlers cannot be unit-tested */
    process.on('SIGTERM', async () => {
      if (containersStarted && !config.keepContainers) {
        await fastKillAgentContainer();
      }
      await performCleanup('SIGTERM');
      console.error(`Process exiting with code: 143`);
      process.exit(143); // Standard exit code for SIGTERM
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
  });

/**
 * Validates that a format string is one of the allowed values
 * 
 * @param format - Format string to validate
 * @param validFormats - Array of valid format options
 * @throws Exits process with error if format is invalid
 */
export function validateFormat(format: string, validFormats: string[]): void {
  if (!validFormats.includes(format)) {
    logger.error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    process.exit(1);
  }
}

// Predownload action handler - exported for testing
export async function handlePredownloadAction(options: {
  imageRegistry: string;
  imageTag: string;
  agentImage: string;
  enableApiProxy: boolean;
  difcProxy?: boolean;
}): Promise<void> {
  const { predownloadCommand } = await import('./commands/predownload');
  try {
    await predownloadCommand({
      imageRegistry: options.imageRegistry,
      imageTag: options.imageTag,
      agentImage: options.agentImage,
      enableApiProxy: options.enableApiProxy,
      difcProxy: options.difcProxy,
    });
  } catch (error) {
    const exitCode = (error as Error & { exitCode?: number }).exitCode ?? 1;
    process.exit(exitCode);
  }
}

// Predownload subcommand - pre-pull container images
program
  .command('predownload')
  .description('Pre-download Docker images for offline use or faster startup')
  .option(
    '--image-registry <registry>',
    'Container image registry',
    'ghcr.io/github/gh-aw-firewall'
  )
  .option(
    '--image-tag <tag>',
    'Container image tag. Supports optional digest metadata: <tag>,squid=sha256:...,agent=sha256:...,api-proxy=sha256:...',
    'latest'
  )
  .option(
    '--agent-image <value>',
    'Agent image preset (default, act) or custom image',
    'default'
  )
  .option('--enable-api-proxy', 'Also download the API proxy image', false)
  .option('--difc-proxy', 'Also download the CLI proxy image (for --difc-proxy-host)', false)
  .action(handlePredownloadAction);

// Logs subcommand - view Squid proxy logs
const logsCmd = program
  .command('logs')
  .description('View and analyze Squid proxy logs from current or previous runs')
  .option('-f, --follow', 'Follow log output in real-time (like tail -f)', false)
  .option(
    '--format <format>',
    'Output format: raw (as-is), pretty (colorized), json (structured)',
    'pretty'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .option('--list', 'List available log sources', false)
  .option(
    '--with-pid',
    'Enrich logs with PID/process info (real-time only, requires -f)',
    false
  )
  .action(async (options) => {
    // Validate format option
    const validFormats: OutputFormat[] = ['raw', 'pretty', 'json'];
    validateFormat(options.format, validFormats);

    // Warn if --with-pid is used without -f
    if (options.withPid && !options.follow) {
      logger.warn('--with-pid only works with real-time streaming (-f). PID tracking disabled.');
    }

    // Dynamic import to avoid circular dependencies
    const { logsCommand } = await import('./commands/logs');
    await logsCommand({
      follow: options.follow,
      format: options.format as OutputFormat,
      source: options.source,
      list: options.list,
      withPid: options.withPid && options.follow, // Only enable if also following
    });
  });

// Logs stats subcommand - show aggregated statistics
logsCmd
  .command('stats')
  .description('Show aggregated statistics from firewall logs')
  .option(
    '--format <format>',
    'Output format: json, markdown, pretty',
    'pretty'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .action(async (options) => {
    // Validate format option
    const validFormats = ['json', 'markdown', 'pretty'];
    if (!validFormats.includes(options.format)) {
      logger.error(`Invalid format: ${options.format}. Must be one of: ${validFormats.join(', ')}`);
      process.exit(1);
    }

    const { statsCommand } = await import('./commands/logs-stats');
    await statsCommand({
      format: options.format as 'json' | 'markdown' | 'pretty',
      source: options.source,
    });
  });

// Logs summary subcommand - generate summary report (optimized for GitHub Actions)
logsCmd
  .command('summary')
  .description('Generate summary report (defaults to markdown for GitHub Actions)')
  .option(
    '--format <format>',
    'Output format: json, markdown, pretty',
    'markdown'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .action(async (options) => {
    // Validate format option
    const validFormats = ['json', 'markdown', 'pretty'];
    validateFormat(options.format, validFormats);

    const { summaryCommand } = await import('./commands/logs-summary');
    await summaryCommand({
      format: options.format as 'json' | 'markdown' | 'pretty',
      source: options.source,
    });
  });

// Logs audit subcommand - show enriched audit with rule matching
logsCmd
  .command('audit')
  .description('Show firewall audit with policy rule matching (requires policy-manifest.json)')
  .option(
    '--format <format>',
    'Output format: json, markdown, pretty',
    'pretty'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .option('--rule <id>', 'Filter to specific rule ID')
  .option('--domain <domain>', 'Filter to specific domain')
  .option('--decision <decision>', 'Filter to "allowed" or "denied"')
  .action(async (options) => {
    const validFormats = ['json', 'markdown', 'pretty'];
    validateFormat(options.format, validFormats);

    if (options.decision && !['allowed', 'denied'].includes(options.decision)) {
      logger.error(`Invalid decision filter: ${options.decision}. Must be "allowed" or "denied".`);
      process.exit(1);
    }

    const { auditCommand } = await import('./commands/logs-audit');
    await auditCommand({
      format: options.format as 'json' | 'markdown' | 'pretty',
      source: options.source,
      rule: options.rule,
      domain: options.domain,
      decision: options.decision,
    });
  });

// Only parse arguments if this file is run directly (not imported as a module)
if (require.main === module) {
  program.parse();
}
