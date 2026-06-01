/**
 * Verifies that host-iptables.ts correctly re-exports all public symbols
 * from the source modules it wraps.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import * as hostIptables from './host-iptables';
import * as hostIptablesRules from './host-iptables-rules';
import * as hostIptablesNetwork from './host-iptables-network';
import * as hostIptablesCleanup from './host-iptables-cleanup';

describe('host-iptables re-exports', () => {
  it('re-exports setupHostIptables from host-iptables-rules', () => {
    expect(hostIptables.setupHostIptables).toBe(hostIptablesRules.setupHostIptables);
  });

  it('re-exports ensureFirewallNetwork from host-iptables-network', () => {
    expect(hostIptables.ensureFirewallNetwork).toBe(hostIptablesNetwork.ensureFirewallNetwork);
  });

  it('re-exports cleanupHostIptables from host-iptables-cleanup', () => {
    expect(hostIptables.cleanupHostIptables).toBe(hostIptablesCleanup.cleanupHostIptables);
  });
});
