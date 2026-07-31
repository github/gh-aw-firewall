/**
 * Tests for the docker-manager.ts barrel/re-export module.
 *
 * docker-manager.ts itself contains no logic beyond re-exporting symbols from
 * host-env, config-writer, container-lifecycle, and container-cleanup. These
 * tests verify the re-exported bindings are identical to the underlying
 * implementations and exercise a couple of exported functions end-to-end
 * through the barrel to ensure the re-export wiring actually works at runtime
 * (not just reference equality).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

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

describe('docker-manager barrel module', () => {
  describe('re-exported bindings', () => {
    it('re-exports setAwfDockerHost, getLocalDockerEnv, parseDifcProxyHost from host-env', () => {
      expect(dockerManager.setAwfDockerHost).toBe(hostEnv.setAwfDockerHost);
      expect(dockerManager.getLocalDockerEnv).toBe(hostEnv.getLocalDockerEnv);
      expect(dockerManager.parseDifcProxyHost).toBe(hostEnv.parseDifcProxyHost);
    });

    it('re-exports writeConfigs from config-writer', () => {
      expect(dockerManager.writeConfigs).toBe(configWriter.writeConfigs);
    });

    it('re-exports startContainers, runAgentCommand, fastKillAgentContainer from container-lifecycle', () => {
      expect(dockerManager.startContainers).toBe(containerLifecycle.startContainers);
      expect(dockerManager.runAgentCommand).toBe(containerLifecycle.runAgentCommand);
      expect(dockerManager.fastKillAgentContainer).toBe(containerLifecycle.fastKillAgentContainer);
    });

    it('re-exports collectDiagnosticLogs, stopContainers, preserveIptablesAudit, cleanup from container-cleanup', () => {
      expect(dockerManager.collectDiagnosticLogs).toBe(containerCleanup.collectDiagnosticLogs);
      expect(dockerManager.stopContainers).toBe(containerCleanup.stopContainers);
      expect(dockerManager.preserveIptablesAudit).toBe(containerCleanup.preserveIptablesAudit);
      expect(dockerManager.cleanup).toBe(containerCleanup.cleanup);
    });
  });

  describe('parseDifcProxyHost through the barrel', () => {
    it('parses a host:port string', () => {
      expect(dockerManager.parseDifcProxyHost('example.com:8080')).toEqual({
        host: 'example.com',
        port: '8080',
      });
    });

    it('defaults on empty input', () => {
      expect(dockerManager.parseDifcProxyHost('')).toEqual({
        host: 'host.docker.internal',
        port: '18443',
      });
    });

    it('handles IPv6 bracketed notation', () => {
      expect(dockerManager.parseDifcProxyHost('[::1]:18443')).toEqual({
        host: '::1',
        port: '18443',
      });
    });
  });

  describe('cleanup through the barrel', () => {
    it('skips cleanup and returns early when keepFiles is true', async () => {
      await expect(
        dockerManager.cleanup('/tmp/awf-nonexistent-workdir', true),
      ).resolves.toBeUndefined();
    });

    it('returns without throwing when the work directory does not exist', async () => {
      await expect(
        dockerManager.cleanup('/tmp/awf-does-not-exist-xyz', false),
      ).resolves.toBeUndefined();
    });
  });
});
