/**
 * Log aggregation module for computing statistics from parsed log entries
 */

import * as fs from 'fs';
import * as path from 'path';
import { execa } from 'execa';
import { LogSource, ParsedLogEntry } from '../types';
import { parseLogLine, parseAuditJsonlLine } from './log-parser';
import { logger } from '../logger';

/**
 * Statistics for a single domain
 */
export interface DomainStats {
  /** Domain name */
  domain: string;
  /** Number of allowed requests */
  allowed: number;
  /** Number of denied requests */
  denied: number;
  /** Total number of requests */
  total: number;
}

/**
 * Aggregated statistics from log entries
 */
export interface AggregatedStats {
  /** Total number of requests */
  totalRequests: number;
  /** Number of allowed requests */
  allowedRequests: number;
  /** Number of denied requests */
  deniedRequests: number;
  /** Number of unique domains */
  uniqueDomains: number;
  /** Statistics grouped by domain */
  byDomain: Map<string, DomainStats>;
  /** Time range of the logs (null if no entries) */
  timeRange: { start: number; end: number } | null;
  /** Per-rule hit statistics (populated when policy manifest is available) */
  byRule?: import('./audit-enricher').RuleStats[];
}

/**
 * Parses lines of text into log entries using the given parser function.
 */
function parseLines(
  content: string,
  parser: (line: string) => ParsedLogEntry | null
): ParsedLogEntry[] {
  const entries: ParsedLogEntry[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const entry = parser(trimmed);
    if (entry) {
      entries.push(entry);
    } else {
      logger.debug(`Failed to parse log line: ${trimmed}`);
    }
  }

  return entries;
}

/**
 * Aggregates parsed log entries into statistics
 *
 * @param entries - Array of parsed log entries
 * @returns Aggregated statistics
 */
export function aggregateLogs(entries: ParsedLogEntry[]): AggregatedStats {
  const byDomain = new Map<string, DomainStats>();
  let allowedRequests = 0;
  let deniedRequests = 0;
  let minTimestamp = Infinity;
  let maxTimestamp = -Infinity;
  let totalRequests = 0;

  for (const entry of entries) {
    // Track time range for all entries
    if (entry.timestamp < minTimestamp) {
      minTimestamp = entry.timestamp;
    }
    if (entry.timestamp > maxTimestamp) {
      maxTimestamp = entry.timestamp;
    }

    // Skip benign operational entries (connection closures without HTTP headers)
    // These appear during healthchecks and shutdown-time keep-alive connection closures
    if (entry.url === 'error:transaction-end-before-headers') {
      continue;
    }

    // Count this as a real request
    totalRequests++;

    // Count allowed/denied
    if (entry.isAllowed) {
      allowedRequests++;
    } else {
      deniedRequests++;
    }

    // Group by domain
    const domain = entry.domain || '-';
    let domainStats = byDomain.get(domain);
    if (!domainStats) {
      domainStats = {
        domain,
        allowed: 0,
        denied: 0,
        total: 0,
      };
      byDomain.set(domain, domainStats);
    }

    domainStats.total++;
    if (entry.isAllowed) {
      domainStats.allowed++;
    } else {
      domainStats.denied++;
    }
  }

  const uniqueDomains = byDomain.size;
  const timeRange =
    entries.length > 0 ? { start: minTimestamp, end: maxTimestamp } : null;

  return {
    totalRequests,
    allowedRequests,
    deniedRequests,
    uniqueDomains,
    byDomain,
    timeRange,
  };
}

/**
 * Loads all log entries from a source
 *
 * @param source - Log source (running container or preserved file)
 * @returns Array of parsed log entries
 */
export async function loadAllLogs(source: LogSource): Promise<ParsedLogEntry[]> {
  let content: string;

  if (source.type === 'running') {
    // Read from running container
    if (!source.containerName) {
      throw new Error('Container name is required for running log source');
    }
    logger.debug(`Loading logs from container: ${source.containerName}`);
    try {
      const result = await execa('docker', [
        'exec',
        source.containerName,
        'cat',
        '/var/log/squid/access.log',
      ]);
      content = result.stdout;
    } catch (error) {
      logger.debug(`Failed to read from container: ${error}`);
      return [];
    }
  } else {
    // Read from file — prefer audit.jsonl (structured) over access.log (text)
    if (!source.path) {
      throw new Error('Path is required for preserved log source');
    }

    const jsonlPath = path.join(source.path, 'audit.jsonl');
    const textPath = path.join(source.path, 'access.log');

    // Try JSONL first, fall back to text format
    if (fs.existsSync(jsonlPath)) {
      const jsonlContent = fs.readFileSync(jsonlPath, 'utf-8');
      const jsonlEntries = parseLines(jsonlContent, parseAuditJsonlLine);
      if (jsonlEntries.length > 0) {
        logger.debug(`Loaded ${jsonlEntries.length} entries from JSONL: ${jsonlPath}`);
        return jsonlEntries;
      }
      logger.debug(`JSONL file had no parseable entries, falling back to text format`);
    }

    if (fs.existsSync(textPath)) {
      content = fs.readFileSync(textPath, 'utf-8');
      logger.debug(`Loading logs from text: ${textPath}`);
    } else {
      logger.debug(`No log files found in: ${source.path}`);
      return [];
    }
  }

  // Parse all lines (for running container source or text file fallback)
  return parseLines(content, parseLogLine);
}

/**
 * Loads logs from a source and aggregates them into statistics
 *
 * @param source - Log source
 * @returns Aggregated statistics
 */
export async function loadAndAggregate(source: LogSource): Promise<AggregatedStats> {
  const entries = await loadAllLogs(source);
  return aggregateLogs(entries);
}
