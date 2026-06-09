import * as fs from 'fs';
import * as path from 'path';
import { BlockedTarget } from './types';
import { logger } from './logger';
import { parseLogLine } from './logs/log-parser';

export interface SquidLogCheckResult {
  hasDenials: boolean;
  blockedTargets: BlockedTarget[];
}

/**
 * Checks Squid logs for access denials to provide better error context
 * @param workDir - Working directory containing configs
 * @param proxyLogsDir - Optional custom directory where proxy logs are written
 */
export async function checkSquidLogs(workDir: string, proxyLogsDir?: string): Promise<SquidLogCheckResult> {
  try {
    // Read from the access.log file (Squid doesn't write access logs to stdout)
    // If proxyLogsDir is specified, logs are written directly there
    const squidLogsDir = proxyLogsDir || path.join(workDir, 'squid-logs');
    const accessLogPath = path.join(squidLogsDir, 'access.log');
    let logContent = '';

    if (fs.existsSync(accessLogPath)) {
      logContent = fs.readFileSync(accessLogPath, 'utf-8');
    } else {
      logger.debug(`Squid access log not found at: ${accessLogPath}`);
      return { hasDenials: false, blockedTargets: [] };
    }

    const blockedTargets: BlockedTarget[] = [];
    const seenTargets = new Set<string>();
    const lines = logContent.split('\n');

    for (const line of lines) {
      // Look for TCP_DENIED entries in Squid logs
      if (line.includes('TCP_DENIED')) {
        const parsedLine = parseLogLine(line);
        if (!parsedLine || !parsedLine.decision.startsWith('TCP_DENIED')) {
          continue;
        }

        const target = extractBlockedTarget(parsedLine.method, parsedLine.host, parsedLine.url);
        if (!seenTargets.has(target)) {
          seenTargets.add(target);
          blockedTargets.push(parseTarget(target));
        }
      }
    }
    return { hasDenials: blockedTargets.length > 0, blockedTargets };
  } catch (error) {
    logger.debug('Could not check Squid logs:', error);
    return { hasDenials: false, blockedTargets: [] };
  }
}

function extractBlockedTarget(method: string, host: string, url: string): string {
  if (method !== 'CONNECT' && host && host !== '-') {
    return normalizeTarget(host);
  }
  return normalizeTarget(url);
}

function normalizeTarget(target: string): string {
  if (!target.includes('://')) {
    return target;
  }
  try {
    const parsed = new URL(target);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return target;
  }
}

function parseTarget(target: string): BlockedTarget {
  const colonIndex = target.lastIndexOf(':');
  if (colonIndex === -1) {
    return { target, domain: target };
  }

  const domain = target.substring(0, colonIndex);
  const port = target.substring(colonIndex + 1);
  if (!/^\d+$/.test(port)) {
    return { target, domain: target };
  }

  return { target, domain, port };
}
