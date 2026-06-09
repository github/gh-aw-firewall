import * as fs from 'fs';
import * as path from 'path';
import { BlockedTarget } from './types';
import { logger } from './logger';

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
      // Format: timestamp IP domain:port dest:port version method status TCP_DENIED:HIER_NONE domain:port "user-agent"
      if (line.includes('TCP_DENIED')) {
        // Extract the domain:port which appears after the method
        // Example: "1760994429.358 172.30.0.20:36274 github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:8443 "curl/7.81.0""
        const match = line.match(/(?:GET|POST|CONNECT|PUT|DELETE|HEAD)\s+\d+\s+TCP_DENIED:\S+\s+([^\s]+)/);
        if (match && match[1]) {
          const target = match[1]; // Full target with port (e.g., "github.com:8443")

          if (!seenTargets.has(target)) {
            seenTargets.add(target);

            // Parse domain and port
            const colonIndex = target.lastIndexOf(':');
            let domain: string;
            let port: string | undefined;

            if (colonIndex !== -1) {
              domain = target.substring(0, colonIndex);
              port = target.substring(colonIndex + 1);

              // Validate that port is actually a number (to handle IPv6 addresses correctly)
              if (!/^\d+$/.test(port)) {
                domain = target;
                port = undefined;
              }
            } else {
              domain = target;
            }

            blockedTargets.push({ target, domain, port });
          }
        }
      }
    }
    return { hasDenials: blockedTargets.length > 0, blockedTargets };
  } catch (error) {
    logger.debug('Could not check Squid logs:', error);
    return { hasDenials: false, blockedTargets: [] };
  }
}
