import { logger } from './logger';
import { fixSquidLogPermissions } from './container-stop';
import { checkSquidLogs } from './squid-log-reader';
import { reportBlockedDomains } from './container-startup-diagnostics';

export async function reportSquidBlocks(
  workDir: string,
  allowedDomains: string[],
  exitCode: number,
  proxyLogsDir?: string,
): Promise<string[]> {
  // Small delay to ensure Squid logs are flushed to disk
  await new Promise(resolve => setTimeout(resolve, 200));

  // Squid writes its logs as UID 13, so the runner user cannot read them
  // without a repair from inside the still-running container. Do this before
  // reading access.log, otherwise the diagnostics below fail with EACCES.
  await fixSquidLogPermissions();

  // Check Squid logs to see if any domains were blocked (do this BEFORE cleanup)
  const { hasDenials, blockedTargets } = await checkSquidLogs(workDir, proxyLogsDir);

  // If command failed (non-zero exit) and domains were blocked, show a warning
  if (exitCode !== 0 && hasDenials) {
    logger.warn('Firewall blocked domains:');
    reportBlockedDomains(blockedTargets, allowedDomains, msg => logger.warn(msg));
  }

  return blockedTargets.map(b => b.domain);
}
