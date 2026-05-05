/**
 * Log formatter for different output formats (raw, pretty, json)
 */

import chalk from 'chalk';
import { ParsedLogEntry, OutputFormat, EnhancedLogEntry } from '../types';

/**
 * Options for log formatting
 */
interface LogFormatterOptions {
  /** Output format */
  format: OutputFormat;
  /** Whether to colorize output (for pretty format). Defaults to true if stdout is TTY */
  colorize?: boolean;
}

/**
 * Formats parsed log entries into different output formats
 */
export class LogFormatter {
  private format: OutputFormat;
  private colorize: boolean;

  constructor(options: LogFormatterOptions) {
    this.format = options.format;
    this.colorize = options.colorize ?? process.stdout.isTTY ?? false;
  }

  /**
   * Formats a parsed log entry (supports both ParsedLogEntry and EnhancedLogEntry)
   *
   * @param entry - Parsed log entry (may include PID info)
   * @returns Formatted string with newline
   */
  formatEntry(entry: ParsedLogEntry | EnhancedLogEntry): string {
    switch (this.format) {
      case 'raw':
        throw new Error('Cannot format parsed entry as raw - use formatRaw for raw lines');
      case 'pretty':
        return this.formatPretty(entry);
      case 'json':
        return this.formatJson(entry);
    }
  }

  /**
   * Formats a raw log line (pass-through)
   *
   * @param line - Raw log line
   * @returns Line with newline appended
   */
  formatRaw(line: string): string {
    return line.endsWith('\n') ? line : line + '\n';
  }

  /**
   * Formats an entry as pretty, human-readable output
   */
  private formatPretty(entry: ParsedLogEntry | EnhancedLogEntry): string {
    // Format timestamp as readable date
    const date = new Date(entry.timestamp * 1000);
    const timeStr = date.toISOString().replace('T', ' ').substring(0, 23);

    // Format target (domain:port or just domain for standard ports)
    const port = this.getDisplayPort(entry);
    const target = port ? `${entry.domain}:${port}` : entry.domain;

    // Status text
    const statusText = entry.isAllowed ? 'ALLOWED' : 'DENIED';

    // User agent (show if not empty/dash)
    const userAgentPart =
      entry.userAgent && entry.userAgent !== '-' ? ` [${entry.userAgent}]` : '';

    // PID info (show if available)
    const enhancedEntry = entry as EnhancedLogEntry;
    const pidPart = enhancedEntry.pid !== undefined && enhancedEntry.pid !== -1
      ? ` <PID:${enhancedEntry.pid} ${enhancedEntry.comm || 'unknown'}>`
      : '';

    // Build message
    const message = `[${timeStr}] ${entry.method} ${target} → ${entry.statusCode} (${statusText})${userAgentPart}${pidPart}`;

    // Colorize based on allowed/denied
    if (!this.colorize) {
      return message + '\n';
    }

    return entry.isAllowed ? chalk.green(message) + '\n' : chalk.red(message) + '\n';
  }

  /**
   * Formats an entry as JSON (newline-delimited)
   */
  private formatJson(entry: ParsedLogEntry | EnhancedLogEntry): string {
    return JSON.stringify(entry) + '\n';
  }

  /**
   * Formats a batch of entries (primarily for JSON array output)
   */
  formatBatch(entries: (ParsedLogEntry | EnhancedLogEntry)[]): string {
    if (this.format === 'json') {
      return entries.map(e => this.formatJson(e)).join('');
    }
    return entries.map(e => this.formatEntry(e)).join('');
  }

  /**
   * Gets the port for display, returning undefined for standard ports
   */
  private getDisplayPort(entry: ParsedLogEntry): string | undefined {
    // Extract port from URL for CONNECT
    if (entry.method === 'CONNECT') {
      const colonIndex = entry.url.lastIndexOf(':');
      if (colonIndex !== -1) {
        const port = entry.url.substring(colonIndex + 1);
        // Hide standard HTTPS port
        if (port === '443') {
          return undefined;
        }
        return port;
      }
    }

    // For other methods, check destPort
    if (entry.destPort && entry.destPort !== '-') {
      // Hide standard ports
      if (entry.destPort === '443' || entry.destPort === '80') {
        return undefined;
      }
      return entry.destPort;
    }

    return undefined;
  }
}
