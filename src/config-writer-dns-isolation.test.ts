/**
 * Config-writer integration tests for DNS filtering in network-isolation mode.
 *
 * Covers the gate at src/config-writer.ts lines 330-333:
 * - Non-portable resolvers are filtered only when networkIsolation is enabled
 *   and dnsServersExplicit is false (auto-detected).
 * - The filtered (effective) DNS list is passed to generateSquidConfig.
 * - The filtered (effective) DNS list is also used in the policy-manifest audit
 *   artifact, not the raw config.dnsServers list.
 * - Explicitly-supplied DNS servers are never filtered in isolation mode.
 */

// Hoisted jest.mock() registrations live in the shared helper — must remain first.
import './test-helpers/config-writer-dependency-mocks.test-utils';

import { EventEmitter } from 'events';
import * as net from 'net';
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

describe('writeConfigs — DNS filtering in network-isolation mode', () => {
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

  describe('isolation mode + auto-detected DNS — non-portable servers are checked', () => {
    it('retains reachable GKE NodeLocal DNS in the Squid config', async () => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: jest.Mock;
        setTimeout: jest.Mock;
      };
      socket.destroy = jest.fn();
      socket.setTimeout = jest.fn();
      (net.createConnection as jest.Mock).mockImplementationOnce(() => {
        process.nextTick(() => socket.emit('connect'));
        return socket;
      });

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

    it('filters Azure DHCP DNS from Squid config', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      // 168.63.129.16 is non-portable; fallback to default public DNS
      expect(squidCall.dnsServers).toEqual(['8.8.8.8', '8.8.4.4']);
    });

    it('filters Tailscale Magic DNS from Squid config', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['100.100.100.100'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['8.8.8.8', '8.8.4.4']);
    });

    it('keeps portable servers from a mixed list and removes non-portable ones', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16', '8.8.8.8', '1.1.1.1'],
          dnsServersExplicit: false,
        })
      );

      const squidCall = getSquidConfigMock().generateSquidConfig.mock.calls[0][0];
      expect(squidCall.dnsServers).toEqual(['8.8.8.8', '1.1.1.1']);
    });

    it('passes the filtered list (not config.dnsServers) to the policy manifest', async () => {
      await writeConfigs(
        buildWriteConfig(tempDir, {
          networkIsolation: true,
          dnsServers: ['168.63.129.16', '8.8.8.8'],
          dnsServersExplicit: false,
        })
      );

      const manifestCall = getSquidConfigMock().generatePolicyManifest.mock.calls[0][0];
      // Policy manifest must reflect what Squid actually uses, not the raw detected list
      expect(manifestCall.dnsServers).toEqual(['8.8.8.8']);
      expect(manifestCall.dnsServers).not.toContain('168.63.129.16');
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
