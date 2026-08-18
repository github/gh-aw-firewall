/**
 * Config-writer integration tests for DNS preservation in network-isolation mode.
 *
 * Covers the gate at src/config-writer.ts lines 330-333:
 * - Auto-detected resolvers are preserved when networkIsolation is enabled
 *   and dnsServersExplicit is false.
 * - The effective DNS list is passed to generateSquidConfig.
 * - The effective DNS list is also used in the policy-manifest audit
 *   artifact, not the raw config.dnsServers list.
 * - Explicitly-supplied DNS servers are also preserved in isolation mode.
 */

// Hoisted jest.mock() registrations live in the shared helper — must remain first.
import './test-helpers/config-writer-dependency-mocks.test-utils';

import { writeConfigs } from './config-writer';
import {
  buildWriteConfig,
  setupConfigWriterTempDir,
  cleanupConfigWriterTempDir,
} from './test-helpers/config-writer-test-harness.test-utils';

// The mock factories from squid-config and squid-config are registered in
// config-writer-dependency-mocks.test-utils above; access them via requireMock.
function getSquidConfigMock() {
  return jest.requireMock('./squid-config') as {
    generateSquidConfig: jest.Mock;
    generatePolicyManifest: jest.Mock;
  };
}

describe('writeConfigs — DNS preservation in network-isolation mode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupConfigWriterTempDir('config-writer-dns-isolation-');
    getSquidConfigMock().generateSquidConfig.mockReturnValue('# mock squid config');
    getSquidConfigMock().generatePolicyManifest.mockReturnValue({});
  });

  afterEach(() => {
    cleanupConfigWriterTempDir(tempDir);
  });

  describe('non-isolation mode — no filtering regardless of portability', () => {
    it('passes Azure DHCP DNS unchanged to Squid when networkIsolation is false', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: false,
          dnsServers: ['168.63.129.16'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['168.63.129.16']);
    });

    it('passes Azure DHCP DNS unchanged to policy manifest when networkIsolation is false', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: false,
          dnsServers: ['168.63.129.16'],
          dnsServersExplicit: false,
        })
      );

      const manifestCall = getSquidConfigMock().generatePolicyManifest.mock.calls[0][0];
      expect(manifestCall.dnsServers).toEqual(['168.63.129.16']);
    });
  });

  describe('isolation mode + auto-detected DNS — runner resolvers are preserved', () => {
    it('retains GKE NodeLocal DNS in the Squid config', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['169.254.20.10'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['169.254.20.10']);
    });

    it('preserves Azure DHCP DNS in Squid config', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16'],
          dnsServersExplicit: false,
        })
      );
      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['168.63.129.16']);
    });

    it('preserves Tailscale Magic DNS in Squid config', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['100.100.100.100'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['100.100.100.100']);
    });

    it('preserves mixed resolver lists without removing detected entries', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16', '8.8.8.8', '1.1.1.1'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['168.63.129.16', '8.8.8.8', '1.1.1.1']);
    });

    it('passes the preserved list to the policy manifest', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16', '8.8.8.8'],
          dnsServersExplicit: false,
        })
      );

      const manifestCall = getSquidConfigMock().generatePolicyManifest.mock.calls[0][0];
      expect(manifestCall.dnsServers).toEqual(['168.63.129.16', '8.8.8.8']);
    });
  });

  describe('isolation mode + explicit DNS — operator choice is respected', () => {
    it('does not filter explicitly-specified Azure DHCP DNS in isolation mode', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16'],
          dnsServersExplicit: true,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['168.63.129.16']);
    });

    it('passes explicit non-portable DNS unchanged to the policy manifest', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16'],
          dnsServersExplicit: true,
        })
      );

      const manifestCall = getSquidConfigMock().generatePolicyManifest.mock.calls[0][0];
      expect(manifestCall.dnsServers).toEqual(['168.63.129.16']);
    });

    it('does not filter explicitly-specified portable DNS in isolation mode', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['1.1.1.1', '9.9.9.9'],
          dnsServersExplicit: true,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['1.1.1.1', '9.9.9.9']);
    });
  });
});
