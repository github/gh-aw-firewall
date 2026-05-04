/**
 * Command handler for `awf logs summary` subcommand
 *
 * This command is designed specifically for generating GitHub Actions step summaries.
 * It defaults to markdown output format for easy piping to $GITHUB_STEP_SUMMARY.
 */

import type { LogStatsFormat } from '../types';
import { runLogsCommand } from './logs-command-helpers';

/**
 * Output format type for summary command (alias for shared type)
 */
export type SummaryFormat = LogStatsFormat;

/**
 * Options for the summary command
 */
export interface SummaryCommandOptions {
  /** Output format: json, markdown, pretty (default: markdown) */
  format: SummaryFormat;
  /** Specific path to log directory or "running" for live container */
  source?: string;
}

/**
 * Main handler for the `awf logs summary` subcommand
 *
 * Loads logs from the specified source (or auto-discovered source),
 * aggregates statistics, and outputs a summary in the requested format.
 *
 * Designed for GitHub Actions:
 * ```bash
 * awf logs summary >> $GITHUB_STEP_SUMMARY
 * ```
 *
 * @param options - Command options
 */
export async function summaryCommand(options: SummaryCommandOptions): Promise<void> {
  // For summary command: only show info logs in pretty format.
  // This differs intentionally from `logs-stats` which logs for all non-JSON formats.
  // The stricter approach here keeps markdown output (the default, intended for
  // GitHub Actions step summaries) free of extra lines that would pollute $GITHUB_STEP_SUMMARY.
  await runLogsCommand(options, (format) => format === 'pretty');
}
