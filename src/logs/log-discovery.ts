/**
 * Discovery module for finding log sources (running containers and preserved logs)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import { execa } from 'execa';
import { LogSource } from '../types';
import { logger } from '../logger';

/** Default container name for the Squid proxy */
const SQUID_CONTAINER_NAME = 'awf-squid';

/**
 * Discovers all available log sources (running containers and preserved log directories)
 *
 * Checks the following locations:
 * 1. Running awf-squid container
 * 2. AWF_LOGS_DIR environment variable (if set, checks for squid-logs subdir)
 * 3. /tmp/squid-logs-* timestamped directories
 *
 * @returns Array of log sources, sorted with running containers first, then preserved logs by timestamp (newest first)
 */
export async function discoverLogSources(): Promise<LogSource[]> {
  const sources: LogSource[] = [];

  // Check for running container
  const running = await isContainerRunning(SQUID_CONTAINER_NAME);
  if (running) {
    sources.push({
      type: 'running',
      containerName: SQUID_CONTAINER_NAME,
    });
    logger.debug('Found running awf-squid container');
  }

  // Check AWF_LOGS_DIR environment variable
  // Supports two layouts:
  // 1. Direct: AWF_LOGS_DIR/access.log (when --proxy-logs-dir is used)
  // 2. Nested: AWF_LOGS_DIR/squid-logs/access.log (legacy format)
  const envLogsDir = process.env.AWF_LOGS_DIR;
  if (envLogsDir) {
    // First check for direct access.log (from --proxy-logs-dir)
    const directAccessLogPath = path.join(envLogsDir, 'access.log');
    // Then check for nested squid-logs/access.log (legacy format)
    const nestedSquidLogsPath = path.join(envLogsDir, 'squid-logs');
    const nestedAccessLogPath = path.join(nestedSquidLogsPath, 'access.log');

    if (fs.existsSync(directAccessLogPath)) {
      // Direct layout: logs are in AWF_LOGS_DIR directly
      const stat = fs.statSync(directAccessLogPath);
      const timestamp = stat.mtimeMs;
      const date = new Date(timestamp);
      sources.push({
        type: 'preserved',
        path: envLogsDir,
        timestamp,
        dateStr: date.toLocaleString(),
      });
      logger.debug(`Found logs from AWF_LOGS_DIR (direct): ${envLogsDir}`);
    } else if (fs.existsSync(nestedAccessLogPath)) {
      // Nested layout: logs are in AWF_LOGS_DIR/squid-logs/
      const stat = fs.statSync(nestedAccessLogPath);
      const timestamp = stat.mtimeMs;
      const date = new Date(timestamp);
      sources.push({
        type: 'preserved',
        path: nestedSquidLogsPath,
        timestamp,
        dateStr: date.toLocaleString(),
      });
      logger.debug(`Found logs from AWF_LOGS_DIR (nested): ${nestedSquidLogsPath}`);
    }
  }

  // Find preserved log directories in /tmp
  const pattern = path.join(os.tmpdir(), 'squid-logs-*');
  let dirs: string[] = [];

  try {
    dirs = await glob(pattern);
  } catch (error) {
    logger.debug('Error searching for preserved logs:', error);
  }

  for (const dir of dirs) {
    const basename = path.basename(dir);
    const timestampStr = basename.replace('squid-logs-', '');
    const timestamp = parseInt(timestampStr, 10);

    if (isNaN(timestamp)) {
      logger.debug(`Skipping invalid log directory: ${dir}`);
      continue;
    }

    // Check if access.log exists
    const accessLogPath = path.join(dir, 'access.log');
    if (!fs.existsSync(accessLogPath)) {
      logger.debug(`Skipping log directory without access.log: ${dir}`);
      continue;
    }

    const date = new Date(timestamp);
    const dateStr = date.toLocaleString();

    sources.push({
      type: 'preserved',
      path: dir,
      timestamp,
      dateStr,
    });
  }

  // Sort preserved logs by timestamp (newest first)
  const preservedSources = sources.filter(s => s.type === 'preserved');
  preservedSources.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // Running container first, then sorted preserved logs
  const runningSources = sources.filter(s => s.type === 'running');
  return [...runningSources, ...preservedSources];
}

/**
 * Selects the most recent log source
 *
 * Running containers take precedence over preserved logs
 *
 * @param sources - Array of log sources
 * @returns Most recent log source, or null if none available
 */
export function selectMostRecent(sources: LogSource[]): LogSource | null {
  // Running container takes precedence
  const running = sources.find(s => s.type === 'running');
  if (running) {
    return running;
  }

  // Otherwise, most recent preserved logs (already sorted newest first)
  return sources[0] || null;
}

/**
 * Checks if a Docker container is currently running
 *
 * @param containerName - Name of the container to check
 * @returns true if container is running, false otherwise
 */
export async function isContainerRunning(containerName: string): Promise<boolean> {
  try {
    const { stdout } = await execa('docker', [
      'ps',
      '--filter',
      // Security: containerName is from internal constant (SQUID_CONTAINER_NAME = 'awf-squid')
      // and is not user-controlled input. The docker ps --filter is safe here.
      // eslint-disable-next-line local/no-unsafe-execa
      `name=^${containerName}$`,
      '--format',
      '{{.Names}}',
    ]);
    return stdout.trim() === containerName;
  } catch {
    return false;
  }
}

/**
 * Validates and creates a LogSource from a user-specified path or "running" keyword
 *
 * @param source - Path to log directory or "running" for live container
 * @returns LogSource object
 * @throws Error if source is invalid
 */
export async function validateSource(source: string): Promise<LogSource> {
  if (source === 'running') {
    const running = await isContainerRunning(SQUID_CONTAINER_NAME);
    if (!running) {
      throw new Error(`Container ${SQUID_CONTAINER_NAME} is not running`);
    }
    return {
      type: 'running',
      containerName: SQUID_CONTAINER_NAME,
    };
  }

  // Assume it's a path
  const resolvedPath = path.resolve(source);

  // Check if it's a directory containing access.log
  if (fs.existsSync(resolvedPath)) {
    const stat = fs.statSync(resolvedPath);

    if (stat.isDirectory()) {
      const accessLogPath = path.join(resolvedPath, 'access.log');
      if (fs.existsSync(accessLogPath)) {
        return {
          type: 'preserved',
          path: resolvedPath,
        };
      }
      throw new Error(`Directory does not contain access.log: ${resolvedPath}`);
    }

    // If it's a file, assume it's the access.log itself
    if (stat.isFile()) {
      return {
        type: 'preserved',
        path: path.dirname(resolvedPath),
      };
    }
  }

  throw new Error(`Log source not found: ${source}`);
}

/**
 * Lists available log sources in a human-readable format
 *
 * @returns Formatted string listing all available sources
 */
export async function listLogSources(): Promise<string> {
  const sources = await discoverLogSources();

  if (sources.length === 0) {
    const hints = ['No log sources found. Run awf with a command first to generate logs.'];
    hints.push('');
    hints.push('Tip: Set AWF_LOGS_DIR environment variable to auto-discover logs from a custom directory.');
    hints.push('Example: export AWF_LOGS_DIR=/tmp/my-logs');
    return hints.join('\n');
  }

  const lines: string[] = ['Available log sources:'];
  const envLogsDir = process.env.AWF_LOGS_DIR;

  for (const source of sources) {
    if (source.type === 'running') {
      lines.push(`  [running] ${source.containerName} (live container)`);
    } else {
      // Check if this is from AWF_LOGS_DIR
      const isFromEnv = envLogsDir && source.path?.startsWith(envLogsDir);
      const label = isFromEnv ? 'AWF_LOGS_DIR' : 'preserved';
      lines.push(`  [${label}] ${source.path} (${source.dateStr})`);
    }
  }

  return lines.join('\n');
}
