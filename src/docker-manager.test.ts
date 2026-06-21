/**
 * Verifies that docker-manager.ts correctly re-exports the runtime functions
 * from the underlying modules it wraps (backwards-compatibility facade).
 *
 * The primary purpose of these tests is to exercise the re-export lines in
 * docker-manager.ts, which have near-zero coverage when test suites import
 * only from the individual source modules. Each identity assertion also acts
 * as a canary — if a re-export is accidentally removed or redirected to the
 * wrong source the test will fail immediately.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

import * as dockerManager from './docker-manager';
import * as hostEnv from './host-env';
import * as configWriter from './config-writer';
import * as containerLifecycle from './container-lifecycle';
import * as containerCleanup from './container-cleanup';

describe('docker-manager re-exports', () => {
  // -----------------------------------------------------------------------
  // host-env re-exports
  // -----------------------------------------------------------------------
  describe('host-env symbols', () => {
    it('re-exports setAwfDockerHost from host-env', () => {
      expect(dockerManager.setAwfDockerHost).toBe(hostEnv.setAwfDockerHost);
    });

    it('re-exports getLocalDockerEnv from host-env', () => {
      expect(dockerManager.getLocalDockerEnv).toBe(hostEnv.getLocalDockerEnv);
    });

    it('re-exports parseDifcProxyHost from host-env', () => {
      expect(dockerManager.parseDifcProxyHost).toBe(hostEnv.parseDifcProxyHost);
    });
  });

  // -----------------------------------------------------------------------
  // config-writer re-exports
  // -----------------------------------------------------------------------
  describe('config-writer symbols', () => {
    it('re-exports writeConfigs from config-writer', () => {
      expect(dockerManager.writeConfigs).toBe(configWriter.writeConfigs);
    });
  });

  // -----------------------------------------------------------------------
  // container-lifecycle re-exports
  // -----------------------------------------------------------------------
  describe('container-lifecycle symbols', () => {
    it('re-exports startContainers from container-lifecycle', () => {
      expect(dockerManager.startContainers).toBe(containerLifecycle.startContainers);
    });

    it('re-exports runAgentCommand from container-lifecycle', () => {
      expect(dockerManager.runAgentCommand).toBe(containerLifecycle.runAgentCommand);
    });

    it('re-exports fastKillAgentContainer from container-lifecycle', () => {
      expect(dockerManager.fastKillAgentContainer).toBe(containerLifecycle.fastKillAgentContainer);
    });
  });

  // -----------------------------------------------------------------------
  // container-cleanup re-exports
  // -----------------------------------------------------------------------
  describe('container-cleanup symbols', () => {
    it('re-exports collectDiagnosticLogs from container-cleanup', () => {
      expect(dockerManager.collectDiagnosticLogs).toBe(containerCleanup.collectDiagnosticLogs);
    });

    it('re-exports stopContainers from container-cleanup', () => {
      expect(dockerManager.stopContainers).toBe(containerCleanup.stopContainers);
    });

    it('re-exports preserveIptablesAudit from container-cleanup', () => {
      expect(dockerManager.preserveIptablesAudit).toBe(containerCleanup.preserveIptablesAudit);
    });

    it('re-exports cleanup from container-cleanup', () => {
      expect(dockerManager.cleanup).toBe(containerCleanup.cleanup);
    });
  });
});
