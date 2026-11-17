import type { NvxCleanupInterfaceIdentity, NvxCleanupRecord } from './cleanup-record';

export function sameInterface(
  current: NvxCleanupInterfaceIdentity,
  expected: NvxCleanupInterfaceIdentity | undefined,
): boolean {
  return expected !== undefined &&
    current.name === expected.name &&
    current.namespace === expected.namespace &&
    current.ifindex === expected.ifindex;
}

export function requireNetwork(record: NvxCleanupRecord): NonNullable<NvxCleanupRecord['network']> {
  if (!record.network) throw new Error('NVX cleanup network plan is not committed');
  return record.network;
}

export function bridgeForwardRule(
  operation: '-C' | '-D',
  bridge: string,
  comment: string,
): string[] {
  return [
    '-t', 'filter', operation, 'DOCKER-USER',
    '-i', bridge, '-o', bridge,
    '-m', 'comment', '--comment', comment,
    '-j', 'ACCEPT',
  ];
}
