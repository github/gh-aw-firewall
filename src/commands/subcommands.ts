import { Command } from 'commander';
import { logger } from '../logger';
import { OutputFormat } from '../types';

/**
 * Validates that a format string is one of the allowed values.
 *
 * @param format - Format string to validate
 * @param validFormats - Array of valid format options
 * @throws Exits process with error if format is invalid
 */
function validateFormat(format: string, validFormats: string[]): void {
  if (!validFormats.includes(format)) {
    logger.error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Predownload action handler — exported for testing.
 */
async function handlePredownloadAction(options: {
  imageRegistry: string;
  imageTag: string;
  agentImage: string;
  enableApiProxy: boolean;
  difcProxy?: boolean;
}): Promise<void> {
  const { predownloadCommand } = await import('./predownload');
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

/**
 * Registers all subcommands (predownload, logs and its sub-subcommands) on the
 * given Commander program instance.
 */
export function registerSubcommands(program: Command): void {
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
      const { logsCommand } = await import('./logs');
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
      const validFormats = ['json', 'markdown', 'pretty'];
      validateFormat(options.format, validFormats);

      const { statsCommand } = await import('./logs-stats');
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
      const validFormats = ['json', 'markdown', 'pretty'];
      validateFormat(options.format, validFormats);

      const { summaryCommand } = await import('./logs-summary');
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

      const { auditCommand } = await import('./logs-audit');
      await auditCommand({
        format: options.format as 'json' | 'markdown' | 'pretty',
        source: options.source,
        rule: options.rule,
        domain: options.domain,
        decision: options.decision,
      });
    });
}
