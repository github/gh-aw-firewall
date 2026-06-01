/**
 * Verifies that docker-manager.ts correctly re-exports all public symbols
 * from the source modules it wraps.
 *
 * These tests ensure the re-export barrel file provides the expected API surface
 * and that consumers importing from `./docker-manager` get the same functions
 * as consumers importing from the underlying modules directly.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

// Mock host-env module to avoid side effects
jest.mock('./host-env', () => {
  const actual = jest.requireActual('./host-env');
  return {
    ...actual,
    getSafeHostUid: () => '1000',
    getSafeHostGid: () => '1000',
  };
});

import * as dockerManager from './docker-manager';
import * as hostEnv from './host-env';
import * as configWriter from './config-writer';
import * as containerLifecycle from './container-lifecycle';
import * as containerCleanup from './container-cleanup';

describe('docker-manager re-exports', () => {
  describe('host-env re-exports', () => {
    it('re-exports setAwfDockerHost', () => {
      expect(dockerManager.setAwfDockerHost).toBe(hostEnv.setAwfDockerHost);
    });

    it('re-exports getLocalDockerEnv', () => {
      expect(dockerManager.getLocalDockerEnv).toBe(hostEnv.getLocalDockerEnv);
    });

    it('re-exports parseDifcProxyHost', () => {
      expect(dockerManager.parseDifcProxyHost).toBe(hostEnv.parseDifcProxyHost);
    });
  });

  describe('config-writer re-exports', () => {
    it('re-exports writeConfigs', () => {
      expect(dockerManager.writeConfigs).toBe(configWriter.writeConfigs);
    });
  });

  describe('container-lifecycle re-exports', () => {
    it('re-exports startContainers', () => {
      expect(dockerManager.startContainers).toBe(containerLifecycle.startContainers);
    });

    it('re-exports runAgentCommand', () => {
      expect(dockerManager.runAgentCommand).toBe(containerLifecycle.runAgentCommand);
    });

    it('re-exports fastKillAgentContainer', () => {
      expect(dockerManager.fastKillAgentContainer).toBe(containerLifecycle.fastKillAgentContainer);
    });
  });

  describe('container-cleanup re-exports', () => {
    it('re-exports collectDiagnosticLogs', () => {
      expect(dockerManager.collectDiagnosticLogs).toBe(containerCleanup.collectDiagnosticLogs);
    });

    it('re-exports stopContainers', () => {
      expect(dockerManager.stopContainers).toBe(containerCleanup.stopContainers);
    });

    it('re-exports preserveIptablesAudit', () => {
      expect(dockerManager.preserveIptablesAudit).toBe(containerCleanup.preserveIptablesAudit);
    });

    it('re-exports cleanup', () => {
      expect(dockerManager.cleanup).toBe(containerCleanup.cleanup);
    });
  });
});
