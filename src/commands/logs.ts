/**
 * Command handler for `awf logs` subcommand
 */

import { OutputFormat } from '../types';
import { logger } from '../logger';
import {
  discoverLogSources,
  selectMostRecent,
  validateSource,
  listLogSources,
  LogFormatter,
  streamLogs,
} from '../logs';

/**
 * Options for the logs command
 */
export interface LogsCommandOptions {
  /** Follow log output in real-time */
  follow?: boolean;
  /** Output format: raw, pretty, json */
  format: OutputFormat;
  /** Specific path to log directory or "running" for live container */
  source?: string;
  /** List available log sources without streaming */
  list?: boolean;
  /** Enrich logs with PID/process info (real-time only) */
  withPid?: boolean;
}

/**
 * Main handler for the `awf logs` subcommand
 *
 * @param options - Command options
 */
export async function logsCommand(options: LogsCommandOptions): Promise<void> {
  // Handle --list flag
  if (options.list) {
    const listing = await listLogSources();
    console.log(listing);
    return;
  }

  // Discover log sources
  const sources = await discoverLogSources();

  // Determine which source to use
  let source;
  if (options.source) {
    // User specified a source
    try {
      source = await validateSource(options.source);
      logger.debug(`Using specified source: ${options.source}`);
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
    source = selectMostRecent(sources);
    if (!source) {
      logger.error('No log sources found.');
      process.exit(1);
    }

    // Log which source we're using
    if (source.type === 'running') {
      logger.info(`Using live logs from running container: ${source.containerName}`);
    } else {
      logger.info(`Using preserved logs from: ${source.path}`);
      if (source.dateStr) {
        logger.info(`Log timestamp: ${source.dateStr}`);
      }
    }
  }

  // Setup formatter
  const formatter = new LogFormatter({
    format: options.format,
    colorize: process.stdout.isTTY,
  });

  // Determine if we should parse logs
  const parse = options.format !== 'raw';

  // Stream logs
  try {
    await streamLogs({
      follow: options.follow || false,
      source,
      formatter,
      parse,
      withPid: options.withPid || false,
    });
  } catch (error) {
    logger.error(`Failed to stream logs: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
