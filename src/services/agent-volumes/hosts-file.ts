import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';
import { getDockerHostStageRoot, shouldUseDockerHostStaging } from './docker-host-staging';

const STALE_CHROOT_STAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function generateHostsFileMount(config: WrapperConfig): string {
  let hostsContent = '127.0.0.1 localhost\n';
  try {
    hostsContent = fs.readFileSync('/etc/hosts', 'utf-8');
  } catch {
    // /etc/hosts not readable, use minimal fallback
  }

  for (const domain of config.allowedDomains) {
    if (domain.startsWith('*.') || domain.startsWith('.') || domain.includes('*')) continue;
    const alreadyPresent = hostsContent.split('\n').some(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return trimmed.split(/\s+/).slice(1).includes(domain);
    });
    if (alreadyPresent) continue;

    try {
      const { stdout } = execa.sync('getent', ['hosts', domain], { timeout: 5000 });
      const parts = stdout.trim().split(/\s+/);
      const ip = parts[0];
      if (ip) {
        hostsContent += `${ip}\t${domain}\n`;
        logger.debug(`Pre-resolved ${domain} -> ${ip} for chroot /etc/hosts`);
      }
    } catch {
      logger.debug(`Could not pre-resolve ${domain} for chroot /etc/hosts (will use DNS at runtime)`);
    }
  }

  if (config.enableHostAccess) {
    try {
      const { stdout } = execa.sync('docker', [
        'network', 'inspect', 'bridge',
        '-f', '{{(index .IPAM.Config 0).Gateway}}'
      ], { timeout: 5000, maxBuffer: 1024 });
      const hostGatewayIp = stdout.trim();
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (hostGatewayIp && ipv4Regex.test(hostGatewayIp)) {
        hostsContent += `${hostGatewayIp}\thost.docker.internal\n`;
        logger.debug(`Added host.docker.internal (${hostGatewayIp}) to chroot-hosts`);

        if (config.localhostDetected) {
          hostsContent = hostsContent.replace(
            /^127\.0\.0\.1\s+localhost(\s+.*)?$/gm,
            `${hostGatewayIp}\tlocalhost$1`
          );
          logger.info('localhost inside container resolves to host machine (localhost keyword active)');
        }
      }
    } catch (err) {
      logger.debug(`Could not resolve Docker bridge gateway: ${err}`);
    }
  }

  const useDockerHostStaging = shouldUseDockerHostStaging(config.dockerHostPathPrefix);
  const hostsRootDir = useDockerHostStaging ? getDockerHostStageRoot(config) : config.workDir;
  if (useDockerHostStaging) {
    pruneStaleChrootStageDirs(hostsRootDir);
  }
  const chrootHostsDir = fs.mkdtempSync(path.join(hostsRootDir, 'chroot-'));
  const chrootHostsPath = path.join(chrootHostsDir, 'hosts');
  fs.writeFileSync(chrootHostsPath, hostsContent, { mode: 0o644 });

  return `${chrootHostsPath}:/host/etc/hosts:ro`;
}

function pruneStaleChrootStageDirs(hostsRootDir: string): void {
  const staleBefore = Date.now() - STALE_CHROOT_STAGE_MAX_AGE_MS;
  try {
    for (const entry of fs.readdirSync(hostsRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('chroot-')) {
        continue;
      }

      const entryPath = path.join(hostsRootDir, entry.name);
      try {
        if (fs.statSync(entryPath).mtimeMs < staleBefore) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch (err) {
        logger.debug(`Could not prune stale chroot hosts staging dir ${entryPath}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`Could not scan chroot hosts staging root ${hostsRootDir}: ${err}`);
  }
}
