/**
 * Command handler for `awf logs stats` subcommand
 */

import type { LogStatsFormat } from '../types';
import { runLogsCommand } from './logs-command-helpers';

/**
 * Output format type for stats command (alias for shared type)
 */
type StatsFormat = LogStatsFormat;

/**
 * Options for the stats command
 */
export interface StatsCommandOptions {
  /** Output format: json, markdown, pretty */
  format: StatsFormat;
  /** Specific path to log directory or "running" for live container */
  source?: string;
}

/**
 * Main handler for the `awf logs stats` subcommand
 *
 * Loads logs from the specified source (or auto-discovered source),
 * aggregates statistics, and outputs in the requested format.
 *
 * @param options - Command options
 */
export async function statsCommand(options: StatsCommandOptions): Promise<void> {
  // For stats command: show info logs for all non-JSON formats
  await runLogsCommand(options, (format) => format !== 'json');
}
