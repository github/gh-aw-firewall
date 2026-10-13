export const MICROVM_SCRATCH_INIT_GUEST_PATH = '/usr/sbin/awf-scratch-init';

/** Runs as PID 1 before the unchanged, release-verified guest supervisor. */
export function buildMicrovmScratchInit(scratchMib: number, supervisorGuestPath: string): string {
  if (!Number.isInteger(scratchMib) || scratchMib < 1 || scratchMib > 0xffffffff) {
    throw new Error('microVM scratch MiB must be an integer in 1-4294967295');
  }
  if (!/^\/[A-Za-z0-9_./-]+$/.test(supervisorGuestPath) || supervisorGuestPath.includes('..')) {
    throw new Error('Unsafe microVM scratch supervisor path');
  }
  const bytes = scratchMib * 1024 * 1024;
  return [
    '#!/bin/sh',
    'set -eu',
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    'export PATH',
    'mkdir -p /proc /tmp',
    'mount -n -t proc proc /proc',
    `mount -n -t tmpfs -o size=${bytes},mode=1777,nosuid,nodev awf-scratch /tmp`,
    "set -- $(stat -f -c '%t %b %S' /tmp)",
    `[ "$#" -eq 3 ] && [ "$1" = 1021994 ] && [ "$(($2 * $3))" -eq ${bytes} ] || {`,
    '  echo "AWF scratch filesystem capacity verification failed" >&2',
    '  exit 1',
    '}',
    `exec '${supervisorGuestPath}'`,
    '',
  ].join('\n');
}
