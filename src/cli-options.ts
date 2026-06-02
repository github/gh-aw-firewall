import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
import { version } from '../package.json';
import { collectRulesetFile, formatItem } from './option-parsers';

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

export const program = new Command();

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
  .option(
    '--docker-host-path-prefix <prefix>',
    'Prefix bind-mount source paths so Docker daemon can resolve runner filesystem paths.\n' +
    '                                       Useful for split runner/daemon filesystems (e.g. ARC DinD).\n' +
    '                                       Example: /host'
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
    '--openai-api-auth-header <name>',
    'Custom auth header name for OpenAI requests (default: Authorization with Bearer prefix)',
  )
  .option(
    '--anthropic-api-auth-header <name>',
    'Custom auth header name for Anthropic requests (default: x-api-key)',
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
  .option(
    '--max-model-multiplier <model:multiplier,...>',
    'Per-model cost multipliers for effective token accounting (requires --enable-api-proxy).\n' +
    '                                       Format: comma-separated model:multiplier pairs, e.g.\n' +
    '                                       claude-opus-4-5-1m:10,claude-opus-4-5-200k:2.5\n' +
    '                                       Multipliers must be positive numbers. Models without\n' +
    '                                       a multiplier default to 1×.',
  )
  .option(
    '--max-model-multiplier-cap <number>',
    'Maximum allowed model cost multiplier (requires --enable-api-proxy).\n' +
    '                                       Requests for models whose resolved multiplier exceeds this cap\n' +
    '                                       are rejected with HTTP 400 and error type model_multiplier_cap_exceeded.\n' +
    '                                       Must be a positive number.',
  )
  .option(
    '--enable-token-steering',
    'Enable effective token budget steering in the API proxy (requires --enable-api-proxy).\n' +
    '                                       Injects budget-warning system messages at 80%, 90%, 95%, and 99%\n' +
    '                                       usage to nudge the agent to wrap up before hitting the hard limit.',
    false
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
  .argument('[args...]', 'Command and arguments to execute (use -- to separate from options)');
