import { execFileSync } from 'child_process';
import { logger } from './logger';
import type { DockerComposeConfig } from './types';
import { getLocalDockerEnv } from './docker-host';

/**
 * Map of standard Linux capability names (uppercase, without CAP_ prefix) to bit positions in CapBnd.
 * Reference: Linux kernel include/uapi/linux/capability.h
 */
export const LINUX_CAPABILITY_MAP: Record<string, number> = {
  CHOWN: 0,
  DAC_OVERRIDE: 1,
  DAC_READ_SEARCH: 2,
  FOWNER: 3,
  FSETID: 4,
  KILL: 5,
  SETGID: 6,
  SETUID: 7,
  SETPCAP: 8,
  LINUX_IMMUTABLE: 9,
  NET_BIND_SERVICE: 10,
  NET_BROADCAST: 11,
  NET_ADMIN: 12,
  NET_RAW: 13,
  IPC_LOCK: 14,
  IPC_OWNER: 15,
  SYS_MODULE: 16,
  SYS_RAWIO: 17,
  SYS_CHROOT: 18,
  SYS_PTRACE: 19,
  SYS_PACCT: 20,
  SYS_ADMIN: 21,
  SYS_BOOT: 22,
  SYS_NICE: 23,
  SYS_RESOURCE: 24,
  SYS_TIME: 25,
  SYS_TTY_CONFIG: 26,
  MKNOD: 27,
  LEASE: 28,
  AUDIT_WRITE: 29,
  AUDIT_CONTROL: 30,
  SETFCAP: 31,
  MAC_OVERRIDE: 32,
  MAC_ADMIN: 33,
  SYSLOG: 34,
  WAKE_ALARM: 35,
  BLOCK_SUSPEND: 36,
  AUDIT_READ: 37,
  PERFMON: 38,
  BPF: 39,
  CHECKPOINT_RESTORE: 40,
};

/**
 * Checks whether the AWF_SKIP_CAP_DROP environment variable is set to a truthy value.
 */
export function isCapDropSkipped(): boolean {
  const val = process.env.AWF_SKIP_CAP_DROP;
  if (!val) return false;
  const lower = val.trim().toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes';
}

/**
 * Parses a Linux capability bounding set from status text.
 */
function parseCapabilityBoundingSet(content: string): bigint | null {
  const match = content.match(/^CapBnd:\s*([0-9a-fA-F]+)$/m);
  if (!match) return null;
  try {
    return BigInt('0x' + match[1]);
  } catch {
    return null;
  }
}

/**
 * Reads the capability bounding set from a privileged container created by the
 * Docker daemon used by AWF. This is deliberately daemon-side: the CLI and a
 * sibling ARC/DinD daemon can have different bounding sets.
 */
export function getHostCapabilityBoundingSet(probeImage = 'alpine:latest'): bigint | null {
  try {
    const content = execFileSync(
      'docker',
      ['run', '--rm', '--pull=never', '--privileged', '--network=none', '--entrypoint', '/bin/sh', probeImage, '-c', 'cat /proc/self/status'],
      { env: getLocalDockerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    );
    return parseCapabilityBoundingSet(content);
  } catch {
    return null;
  }
}

/**
 * Filters a cap_drop list against host capabilities and environment settings.
 *
 * - If AWF_SKIP_CAP_DROP is set to 1/true/yes, returns an empty array.
 * - If CapBnd cannot be read (null), returns the original list unmodified.
 * - Keeps 'ALL' wildcard intact.
 * - Filters out explicit capability names not present in the capability bounding set.
 */
export function filterCapDrop(capDropList?: string[], capBndOverride?: bigint | null): string[] {
  if (!capDropList || capDropList.length === 0) {
    return [];
  }

  if (isCapDropSkipped()) {
    logger.debug('AWF_SKIP_CAP_DROP is set: removing cap_drop requirements');
    return [];
  }

  const capBnd = capBndOverride !== undefined ? capBndOverride : getHostCapabilityBoundingSet();
  if (capBnd === null) {
    return capDropList;
  }

  return capDropList.filter((cap) => {
    const norm = cap.trim().toUpperCase();
    if (norm === 'ALL') {
      return true;
    }
    const capName = norm.replace(/^CAP_/, '');
    const bitIndex = LINUX_CAPABILITY_MAP[capName];
    if (bitIndex === undefined) {
      // Unknown capability name; preserve it by default
      return true;
    }
    const capBit = 1n << BigInt(bitIndex);
    const isPresent = (capBnd & capBit) !== 0n;
    if (!isPresent) {
      logger.debug(`Filtering capability '${cap}' from cap_drop: not present in host capability bounding set`);
    }
    return isPresent;
  });
}

/**
 * Filters cap_drop in all services of a Docker Compose configuration against
 * the host capability bounding set (or AWF_SKIP_CAP_DROP).
 */
export function filterComposeCapDrop(
  composeConfig: DockerComposeConfig,
  capBndOverride?: bigint | null,
): DockerComposeConfig {
  if (!composeConfig?.services) {
    return composeConfig;
  }
  const probeImage = Object.values(composeConfig.services)
    .map((service) => service?.image)
    .find((image): image is string => typeof image === 'string');
  const capBnd = capBndOverride !== undefined
    ? capBndOverride
    : getHostCapabilityBoundingSet(probeImage);
  for (const service of Object.values(composeConfig.services)) {
    if (service && Array.isArray(service.cap_drop)) {
      const filtered = filterCapDrop(service.cap_drop, capBnd);
      if (filtered.length === 0) {
        delete service.cap_drop;
      } else {
        service.cap_drop = filtered;
      }
    }
  }
  return composeConfig;
}
