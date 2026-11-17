import { bridgeForwardRule, requireNetwork, sameInterface } from './cleanup-network-state';
import type { NvxCleanupRecord } from './cleanup-record';

describe('cleanup network state', () => {
  it('matches interface name, namespace and index', () => {
    const current = { name: 'veth0', namespace: 'awf-nvx-test', ifindex: 10 };
    expect(sameInterface(current, { ...current })).toBe(true);
    expect(sameInterface(current, undefined)).toBe(false);
    expect(sameInterface(current, { ...current, name: 'veth1' })).toBe(false);
    expect(sameInterface(current, { ...current, namespace: undefined })).toBe(false);
    expect(sameInterface(current, { ...current, ifindex: 11 })).toBe(false);
    expect(sameInterface({ name: 'host0', ifindex: 1 }, { name: 'host0', ifindex: 1 })).toBe(true);
  });

  it('requires and returns the committed network plan', () => {
    const record = {} as NvxCleanupRecord;
    expect(() => requireNetwork(record)).toThrow(/network plan is not committed/);
    record.network = {
      resourceToken: 'a'.repeat(12),
      namespaceName: 'awf-nvx-test',
      netnsPath: '/var/run/netns/awf-nvx-test',
      hostVethName: 'host0',
      namespaceVethName: 'guest0',
      tapName: 'tap0',
      infrastructureBridge: 'bridge0',
      hostForwardRuleComment: `awf-microvm-${'a'.repeat(12)}`,
    };
    expect(requireNetwork(record)).toBe(record.network);
  });

  it.each(['-C', '-D'] as const)('builds the exact %s bridge forwarding rule', (operation) => {
    expect(bridgeForwardRule(operation, 'bridge0', 'awf-microvm-test')).toEqual([
      '-t', 'filter', operation, 'DOCKER-USER',
      '-i', 'bridge0', '-o', 'bridge0',
      '-m', 'comment', '--comment', 'awf-microvm-test',
      '-j', 'ACCEPT',
    ]);
  });
});
