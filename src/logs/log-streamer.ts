/**
 * Log streaming module for reading logs from containers or files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import execa from 'execa';
import { LogSource, EnhancedLogEntry } from '../types';
import { LogFormatter } from './log-formatter';
import { parseLogLine } from './log-parser';
import { logger } from '../logger';
import { trackPidForPortSync, isPidTrackingAvailable } from '../pid-tracker';

/**
 * Options for streaming logs
 */
export interface StreamOptions {
  /** Follow log output in real-time (like tail -f) */
  follow: boolean;
  /** Log source to stream from */
  source: LogSource;
  /** Formatter for output */
  formatter: LogFormatter;
  /** Whether to parse logs (false for raw format) */
  parse?: boolean;
  /** Whether to enrich logs with PID/process info (real-time only) */
  withPid?: boolean;
}

/**
 * Streams logs from a source to stdout
 *
 * @param options - Streaming options
 */
export async function streamLogs(options: StreamOptions): Promise<void> {
  const { follow, source, formatter, parse = true, withPid = false } = options;

  // Check if PID tracking is available when requested
  if (withPid && !isPidTrackingAvailable()) {
    logger.warn('PID tracking not available on this system (requires /proc filesystem)');
  }

  if (source.type === 'running') {
    await streamFromContainer(source.containerName!, follow, formatter, parse, withPid);
  } else {
    await streamFromFile(source.path!, follow, formatter, parse, withPid);
  }
}

/**
 * Streams logs from a running Docker container
 */
async function streamFromContainer(
  containerName: string,
  follow: boolean,
  formatter: LogFormatter,
  parse: boolean,
  withPid: boolean
): Promise<void> {
  logger.debug(`Streaming logs from container: ${containerName}`);

  // Use docker exec to read logs from within the container
  const args = follow
    ? ['exec', containerName, 'tail', '-f', '/var/log/squid/access.log']
    : ['exec', containerName, 'cat', '/var/log/squid/access.log'];

  const proc = execa('docker', args, {
    reject: false,
  });

  // Setup cleanup on process exit
  const cleanup = () => {
    proc.kill('SIGTERM');
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // Process stdout line-by-line
    if (proc.stdout) {
      const rl = readline.createInterface({
        input: proc.stdout,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        processLine(line, formatter, parse, withPid);
      }
    }

    await proc;
  } catch (error) {
    // Ignore SIGTERM errors (normal termination)
    if (error instanceof Error && 'signal' in error && error.signal === 'SIGTERM') {
      return;
    }
    throw error;
  } finally {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  }
}

/**
 * Streams logs from a preserved log file
 */
async function streamFromFile(
  logDir: string,
  follow: boolean,
  formatter: LogFormatter,
  parse: boolean,
  withPid: boolean
): Promise<void> {
  const filePath = path.join(logDir, 'access.log');

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`Log file not found: ${filePath}`);
  }

  logger.debug(`Reading logs from file: ${filePath}`);

  if (follow) {
    // Use tail -f for live following
    await tailFile(filePath, formatter, parse, withPid);
  } else {
    // Read entire file at once
    await readFile(filePath, formatter, parse, withPid);
  }
}

/**
 * Reads an entire log file
 */
async function readFile(
  filePath: string,
  formatter: LogFormatter,
  parse: boolean,
  withPid: boolean
): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    if (line.trim() === '') continue;
    processLine(line, formatter, parse, withPid);
  }
}

/**
 * Follows a log file using tail -f
 */
async function tailFile(
  filePath: string,
  formatter: LogFormatter,
  parse: boolean,
  withPid: boolean
): Promise<void> {
  const proc = execa('tail', ['-f', filePath], {
    reject: false,
  });

  const cleanup = () => {
    proc.kill('SIGTERM');
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    if (proc.stdout) {
      const rl = readline.createInterface({
        input: proc.stdout,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        processLine(line, formatter, parse, withPid);
      }
    }

    await proc;
  } catch (error) {
    if (error instanceof Error && 'signal' in error && error.signal === 'SIGTERM') {
      return;
    }
    throw error;
  } finally {
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
  }
}

/**
 * Enriches a parsed log entry with PID tracking information
 *
 * @param entry - Parsed log entry
 * @returns Enhanced log entry with PID info (if available)
 */
function enrichWithPid(entry: EnhancedLogEntry): EnhancedLogEntry {
  const port = parseInt(entry.clientPort, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    return entry;
  }

  const pidInfo = trackPidForPortSync(port);
  if (pidInfo.pid !== -1) {
    return {
      ...entry,
      pid: pidInfo.pid,
      cmdline: pidInfo.cmdline,
      comm: pidInfo.comm,
      inode: pidInfo.inode,
    };
  }

  return entry;
}

/**
 * Processes a single log line - parses (if enabled), enriches with PID (if enabled), and outputs
 */
function processLine(line: string, formatter: LogFormatter, parse: boolean, withPid: boolean): void {
  if (!parse) {
    // Raw format - output as-is
    process.stdout.write(formatter.formatRaw(line));
    return;
  }

  // Parse and format
  const entry = parseLogLine(line);
  if (entry) {
    // Enrich with PID info if enabled
    const enhancedEntry = withPid ? enrichWithPid(entry) : entry;
    process.stdout.write(formatter.formatEntry(enhancedEntry));
  } else {
    // Failed to parse, output as raw with a warning indicator
    logger.debug(`Failed to parse log line: ${line}`);
    process.stdout.write(formatter.formatRaw(line));
  }
}
