/**
 * Shared helper functions for log commands (stats, summary, audit)
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import type { LogSource, LogStatsFormat, PolicyManifest } from '../types';
import {
  discoverLogSources,
  selectMostRecent,
  validateSource,
} from '../logs/log-discovery';
import { loadAndAggregate, loadAllLogs } from '../logs/log-aggregator';
import type { AggregatedStats } from '../logs/log-aggregator';
import { enrichWithPolicyRules, computeRuleStats } from '../logs/audit-enricher';
import { formatStats } from '../logs/stats-formatter';

/**
 * Options for determining which logs to show (based on log level)
 */
interface LoggingOptions {
  /** The output format being used */
  format: LogStatsFormat;
  /** Callback to determine if info logs should be shown */
  shouldLog: (format: LogStatsFormat) => boolean;
}

/**
 * Discovers and selects a log source based on user input or auto-discovery.
 * Handles validation, error messages, and optional logging.
 *
 * @param sourceOption - User-specified source path or "running", or undefined for auto-discovery
 * @param loggingOptions - Options controlling when to emit log messages
 * @returns Selected log source
 */
export async function discoverAndSelectSource(
  sourceOption: string | undefined,
  loggingOptions: LoggingOptions
): Promise<LogSource> {
  // Discover log sources
  const sources = await discoverLogSources();

  // Determine which source to use
  let source: LogSource;
  
  if (sourceOption) {
    // User specified a source
    try {
      source = await validateSource(sourceOption);
      logger.debug(`Using specified source: ${sourceOption}`);
    } catch (error) {
      logger.error(
        `Invalid log source: ${error instanceof Error ? error.message : error}`
      );
      process.exit(1);
    }
  } else if (sources.length === 0) {
    logger.error('No log sources found. Run awf with a command first to generate logs.');
    process.exit(1);
  } else {
    // Select most recent source
    const selected = selectMostRecent(sources);
    if (!selected) {
      logger.error('No log sources found.');
      process.exit(1);
    }
    source = selected;

    // Log which source we're using (conditionally based on format)
    if (loggingOptions.shouldLog(loggingOptions.format)) {
      if (source.type === 'running') {
        logger.info(`Using live logs from running container: ${source.containerName}`);
      } else {
        logger.info(`Using preserved logs from: ${source.path}`);
        if (source.dateStr) {
          logger.info(`Log timestamp: ${source.dateStr}`);
        }
      }
    }
  }

  return source;
}

/**
 * Attempts to find a policy-manifest.json near a log source path.
 * Returns null if not found.
 */
export function findPolicyManifestForSource(source: LogSource): PolicyManifest | null {
  if (source.type === 'running' || !source.path) return null;

  const candidates = [
    path.join(source.path, 'policy-manifest.json'),
    path.join(source.path, '..', 'audit', 'policy-manifest.json'),
    source.path.replace(/squid-logs-/, 'awf-audit-').replace(/\/?$/, '/policy-manifest.json'),
  ];

  // AWF_AUDIT_DIR is a fallback, not priority — prefer manifests co-located with
  // the selected log source to avoid cross-run mismatch
  const auditDirEnv = process.env.AWF_AUDIT_DIR;
  if (auditDirEnv) {
    candidates.push(path.join(auditDirEnv, 'policy-manifest.json'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8');
        return JSON.parse(content) as PolicyManifest;
      }
    } catch {
      // Skip
    }
  }

  return null;
}

/**
 * Loads and aggregates logs from a source, handling errors gracefully.
 * Automatically enriches with policy rule stats when a manifest is available.
 *
 * @param source - Log source to load from
 * @returns Aggregated statistics
 */
async function loadLogsWithErrorHandling(
  source: LogSource
): Promise<AggregatedStats> {
  try {
    const stats = await loadAndAggregate(source);

    // Try to enrich with policy rule stats
    const manifest = findPolicyManifestForSource(source);
    if (manifest) {
      const entries = await loadAllLogs(source);
      const enriched = enrichWithPolicyRules(entries, manifest);
      stats.byRule = computeRuleStats(enriched, manifest);
      logger.debug('Enriched stats with policy rule matching');
    }

    return stats;
  } catch (error) {
    logger.error(`Failed to load logs: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Shared output pipeline for `logs stats` and `logs summary`.
 *
 * Discovers the log source, loads and aggregates the logs, formats them, and
 * prints the result. Each command passes only the `shouldLog` predicate that
 * controls whether informational source-selection messages are emitted.
 *
 * @param options - Command options containing `format` and optional `source`
 * @param shouldLog - Returns true when info-level log messages should be shown
 */
export async function runLogsCommand(
  options: { format: LogStatsFormat; source?: string },
  shouldLog: (format: LogStatsFormat) => boolean
): Promise<void> {
  const source = await discoverAndSelectSource(options.source, {
    format: options.format,
    shouldLog,
  });

  const stats = await loadLogsWithErrorHandling(source);

  const colorize = !!(process.stdout.isTTY && options.format === 'pretty');
  const output = formatStats(stats, options.format, colorize);
  console.log(output);
}
