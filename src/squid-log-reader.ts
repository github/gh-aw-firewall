import * as fs from 'fs';
import * as path from 'path';
import { BlockedTarget, PolicyManifest } from './types';
import { logger } from './logger';
import { parseLogLine } from './logs/log-parser';
import { isInternalAwfDomain } from './logs/internal-domain-filter';

/**
 * Reads the policy manifest from workDir, if present, returning the topology
 * peer hostnames and the effective `awf-net` subnet recorded for the run.
 * Returns empty defaults when the manifest is absent or unreadable.
 */
function loadManifestContext(workDir: string): { topologyPeers: ReadonlySet<string>; networkSubnet?: string } {
  const manifestPath = path.join(workDir, 'audit', 'policy-manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PolicyManifest;
      const topologyPeers = Array.isArray(manifest.topologyPeers) && manifest.topologyPeers.length > 0
        ? new Set(manifest.topologyPeers.map(p => p.toLowerCase()))
        : new Set<string>();
      return { topologyPeers, networkSubnet: manifest.networkSubnet };
    }
  } catch {
    logger.debug(`Could not read policy manifest: ${manifestPath}`);
  }
  return { topologyPeers: new Set() };
}

/**
 * Checks Squid logs for access denials to provide better error context
 * @param workDir - Working directory containing configs
 * @param proxyLogsDir - Optional custom directory where proxy logs are written
 */
export async function checkSquidLogs(workDir: string, proxyLogsDir?: string): Promise<{ hasDenials: boolean; blockedTargets: BlockedTarget[] }> {
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

    // Load topology peers and the effective subnet from the policy manifest so
    // that dotted peer names (e.g. mcp.gateway-01) and relocated (--network-subnet)
    // in-subnet IPs are suppressed in addition to single-label names.
    const { topologyPeers: knownTopologyPeers, networkSubnet } = loadManifestContext(workDir);

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
        const parsed = parseTarget(target);

        // Skip AWF-internal addresses (Docker network IPs and container hostnames).
        // These are container-to-container connections, not missing external
        // dependencies — surfacing them as blocked external domains is noise.
        if (isInternalAwfDomain(parsed.domain, knownTopologyPeers, networkSubnet)) {
          continue;
        }

        if (!seenTargets.has(target)) {
          seenTargets.add(target);
          blockedTargets.push(parsed);
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
