import {
  startContainers,
  runAgentCommand,
  fastKillAgentContainer,
} from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { setAwfDockerHost, getLocalDockerEnv } from './docker-host';
import { stopContainers } from './container-stop';
import { AGENT_CONTAINER_NAME } from './constants';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions

// Mock execa module
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { mockStartupRetry, expectComposeUpAttempts } from './test-helpers/startup-retry.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('docker-manager lifecycle', () => {
  describe('startContainers', () => {
    const { getDir } = useTempDir();

    it('should remove existing containers before starting', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com']);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'awf-squid', 'awf-agent', 'awf-iptables-init', 'awf-api-proxy', 'awf-cli-proxy'],
        expect.objectContaining({ reject: false })
      );
    });

    it('should continue when removing existing containers fails', async () => {
      // First call (docker rm) throws an error, but we should continue
      mockExecaFn.mockRejectedValueOnce(new Error('No such container'));
      // Second call (docker compose up) succeeds
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com']);

      // Should still call docker compose up even if rm failed
      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should run docker compose up', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com']);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should run docker compose up with --pull never when skipPull is true', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com'], undefined, true);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d', '--pull', 'never'],
        expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should run docker compose up without --pull never when skipPull is false', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com'], undefined, false);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should handle docker compose failure', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockRejectedValueOnce(new Error('Docker compose failed'));

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow('Docker compose failed');
    });

    it('should handle healthcheck failure with blocked domains', async () => {
      // Create access.log with denied entries
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockRejectedValueOnce(new Error('is unhealthy'));

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow();
    });

    it('should retry once when awf-api-proxy fails its health check', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - fails with api-proxy unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
      // 3. docker logs --tail 50 awf-api-proxy (get logs for diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy startup logs', stderr: '', exitCode: 0 } as any);
      // 4. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 5. docker compose up (retry - succeeds)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      // Verify retry happened: compose up was called twice
      expectComposeUpAttempts(2);
      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'down', '-v', '-t', '1'],
        expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit', reject: false })
      );
    });

    it('should retry once when awf-api-proxy exits during startup', async () => {
      mockStartupRetry({
        firstError: 'dependency failed to start: container awf-api-proxy exited (1)',
        logs: 'api-proxy startup logs',
      });

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      expectComposeUpAttempts(2);
    });

    it('should retry once when docker compose only reports a generic error but awf-api-proxy already exited', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - generic execa error)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 3. docker inspect awf-api-proxy (fallback diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'exited', stderr: '', exitCode: 0 } as any);
      // 4. docker logs --tail 50 awf-api-proxy (get logs for diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy startup logs', stderr: '', exitCode: 0 } as any);
      // 5. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 6. docker compose up (retry - succeeds)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      const inspectCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'inspect' && call[1][1] === 'awf-api-proxy'
      );
      expect(inspectCalls).toHaveLength(1);

      expectComposeUpAttempts(2);
    });

    it('should throw clear error when awf-api-proxy fails its health check on both attempts', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - fails)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
      // 3. docker logs (first diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);
      // 4. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 5. docker compose up (retry - also fails)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
      // 6. docker logs (second diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'AWF firewall failed to start: awf-api-proxy failed to start on both attempts'
      );
    });

    it('should throw clear error when awf-api-proxy exits during startup on both attempts', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - fails)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy exited (1)'));
      // 3. docker logs (first diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);
      // 4. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 5. docker compose up (retry - also fails)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy exited (1)'));
      // 6. docker logs (second diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'AWF firewall failed to start: awf-api-proxy failed to start on both attempts'
      );
    });

    it('should throw clear error when generic compose failures map to awf-api-proxy startup failures on both attempts', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - generic execa error)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 3. docker inspect (first diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'exited', stderr: '', exitCode: 0 } as any);
      // 4. docker logs (first diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);
      // 5. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 6. docker compose up (retry - also generic execa error)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 7. docker inspect (second diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'exited', stderr: '', exitCode: 0 } as any);
      // 8. docker logs (second diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'AWF firewall failed to start: awf-api-proxy failed to start on both attempts'
      );
    });

    it('should retry once when awf-api-proxy exits (1) during startup', async () => {
      mockStartupRetry({
        firstError: 'dependency failed to start: container awf-api-proxy exited (1)',
        logs: 'api-proxy startup logs',
      });

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      // Verify retry happened: compose up was called twice
      expectComposeUpAttempts(2);
    });

    it('should retry once when awf-squid fails its health check', async () => {
      mockStartupRetry({
        firstError: 'dependency failed to start: container awf-squid is unhealthy',
        inspectBeforeLogs: '', // fallback inspect of awf-api-proxy returns empty (not unhealthy)
        logs: 'squid startup logs',
      });

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      // Verify retry happened: compose up was called twice
      expectComposeUpAttempts(2);
      // Verify only awf-api-proxy fallback inspect ran for this squid-specific error
      const apiProxyInspectCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'inspect' && call[1][1] === 'awf-api-proxy'
      );
      expect(apiProxyInspectCalls).toHaveLength(1);
      const squidInspectCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'inspect' && call[1][1] === 'awf-squid'
      );
      expect(squidInspectCalls).toHaveLength(0);
    });

    it('fails fast when awf-cli-proxy startup fails and does not retry compose up', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (fails with cli-proxy unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-cli-proxy is unhealthy'));
      // 3. docker inspect awf-api-proxy (fallback check - healthy)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
      // 4. docker inspect awf-squid (fallback check - healthy)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
      // 5. docker logs --tail 50 awf-cli-proxy (diagnostics before fail-fast throw)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'cli-proxy startup logs', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'AWF firewall failed to start: awf-cli-proxy could not connect to the external DIFC proxy'
      );

      // Verify no retry happened: compose up should be called once
      expectComposeUpAttempts(1);
    });

    it('should route retry error through Squid diagnostics when retry fails with non-api-proxy error', async () => {
      // Create access.log with denied entries so Squid diagnostics fire
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - fails with api-proxy unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
      // 3. docker logs (diagnosis before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'some logs', stderr: '', exitCode: 0 } as any);
      // 4. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 5. docker compose up (retry - fails with a different, non-api-proxy error)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-squid is unhealthy'));
      // 6. docker inspect awf-api-proxy (fallback check in retry error handler - not unhealthy)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 7. docker logs --tail 50 awf-squid (dumped before falling through to diagnostics)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'squid logs', stderr: '', exitCode: 0 } as any);

      // Should surface the Squid blocked-domain error, not a raw throw
      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow('Firewall blocked access to:');
    });

    it('should not emit container logs when docker logs exits non-zero (container not found)', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (fails with api-proxy unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
      // 3. docker logs returns non-zero (container not found)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'No such container: awf-api-proxy', exitCode: 1 } as any);
      // 4. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 5. docker compose up (retry - succeeds)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      // Should succeed without emitting "No such container" noise at error level
      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();
    });

    it('should retry once when docker compose only reports a generic error but awf-squid already exited', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - generic execa error)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 3. docker inspect awf-api-proxy (fallback diagnosis - not failed)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'running|healthy', stderr: '', exitCode: 0 } as any);
      // 4. docker inspect awf-squid (fallback diagnosis - exited)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'exited|', stderr: '', exitCode: 0 } as any);
      // 5. docker logs --tail 50 awf-squid (get logs for diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'squid startup logs', stderr: '', exitCode: 0 } as any);
      // 6. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 7. docker compose up (retry - succeeds)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      const apiProxyInspectCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'inspect' && call[1][1] === 'awf-api-proxy'
      );
      expect(apiProxyInspectCalls).toHaveLength(1);

      const squidInspectCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'inspect' && call[1][1] === 'awf-squid'
      );
      expect(squidInspectCalls).toHaveLength(1);

      expectComposeUpAttempts(2);
    });

    it('should retry once when awf-squid exits during startup', async () => {
      mockStartupRetry({
        firstError: 'dependency failed to start: container awf-squid exited (1)',
        inspectBeforeLogs: '', // fallback inspect of awf-api-proxy returns empty (not unhealthy)
        logs: 'squid startup logs',
      });

      await expect(startContainers(getDir(), ['github.com'])).resolves.toBeUndefined();

      expectComposeUpAttempts(2);
    });

    it('should throw and dump squid logs when awf-squid fails its health check on both attempts', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - fails with squid unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-squid is unhealthy'));
      // 3. docker inspect awf-api-proxy (fallback check - not unhealthy)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 4. docker logs --tail 50 awf-squid (diagnosis before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'squid logs', stderr: '', exitCode: 0 } as any);
      // 5. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 6. docker compose up (retry - also fails with squid unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-squid is unhealthy'));
      // 7. docker inspect awf-api-proxy (fallback check in retry error handler - not unhealthy)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 8. docker logs --tail 50 awf-squid (dumped before falling through to diagnostics)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'squid retry logs', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(getDir(), ['github.com'])).rejects.toThrow(
        'dependency failed to start: container awf-squid is unhealthy'
      );

      expectComposeUpAttempts(2);
    });
  });

  describe('stopContainers', () => {
    const { getDir } = useTempDir();

    it('should skip stopping when keepContainers is true', async () => {
      await stopContainers(getDir(), true);

      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('should run docker compose down when keepContainers is false', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await stopContainers(getDir(), false);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'down', '-v', '-t', '1'],
        expect.objectContaining({ cwd: getDir(), stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should throw error when docker compose down fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('Docker compose down failed'));

      await expect(stopContainers(getDir(), false)).rejects.toThrow('Docker compose down failed');
    });
  });

  describe('fastKillAgentContainer', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      containerLifecycleTestHelpers.resetAgentExternallyKilled();
    });

    it('should call docker stop with default 3-second timeout', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await fastKillAgentContainer();

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['stop', '-t', '3', AGENT_CONTAINER_NAME],
        expect.objectContaining({ reject: false, timeout: 8000 })
      );
    });

    it('should accept a custom stop timeout', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await fastKillAgentContainer(5);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['stop', '-t', '5', AGENT_CONTAINER_NAME],
        expect.objectContaining({ reject: false, timeout: 10000 })
      );
    });

    it('should not throw when docker stop fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('docker not found'));

      await expect(fastKillAgentContainer()).resolves.toBeUndefined();
    });

    it('should set the externally-killed flag', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(false);
      await fastKillAgentContainer();
      expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(true);
    });

    it('should set the externally-killed flag even when docker stop fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('docker not found'));

      await fastKillAgentContainer();
      expect(containerLifecycleTestHelpers.isAgentExternallyKilled()).toBe(true);
    });
  });

  describe('setAwfDockerHost / getLocalDockerEnv (DOCKER_HOST isolation)', () => {
    const originalDockerHost = process.env.DOCKER_HOST;

    afterEach(() => {
      // Restore env and reset override after each test
      if (originalDockerHost === undefined) {
        delete process.env.DOCKER_HOST;
      } else {
        process.env.DOCKER_HOST = originalDockerHost;
      }
      setAwfDockerHost(undefined);
      jest.clearAllMocks();
    });

    it('docker compose up should forward a loopback TCP DOCKER_HOST to the docker CLI', async () => {
      process.env.DOCKER_HOST = 'tcp://localhost:2375';
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      try {
        mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker rm
        mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker compose up

        await startContainers(testDir, ['github.com']);

        const composeCalls = mockExecaFn.mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'compose'
        );
        expect(composeCalls.length).toBeGreaterThan(0);
        const composeEnv = composeCalls[0][2]?.env as Record<string, string | undefined> | undefined;
        // tcp://localhost DOCKER_HOST must be passed through to docker compose (ARC/DinD support)
        expect(composeEnv).toBeDefined();
        expect(composeEnv!.DOCKER_HOST).toBe('tcp://localhost:2375');
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('docker compose up should keep a unix:// DOCKER_HOST in the env', async () => {
      process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      try {
        mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker rm
        mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker compose up

        await startContainers(testDir, ['github.com']);

        const composeCalls = mockExecaFn.mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'compose'
        );
        expect(composeCalls.length).toBeGreaterThan(0);
        const composeEnv = composeCalls[0][2]?.env as Record<string, string | undefined> | undefined;
        expect(composeEnv).toBeDefined();
        expect(composeEnv!.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('setAwfDockerHost should override DOCKER_HOST for AWF operations', async () => {
      process.env.DOCKER_HOST = 'tcp://localhost:2375'; // CLI override wins over env var
      setAwfDockerHost('unix:///run/user/1000/docker.sock');
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      try {
        mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker rm
        mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker compose up

        await startContainers(testDir, ['github.com']);

        const composeCalls = mockExecaFn.mock.calls.filter(
          (call: any[]) => call[1]?.[0] === 'compose'
        );
        expect(composeCalls.length).toBeGreaterThan(0);
        const composeEnv = composeCalls[0][2]?.env as Record<string, string | undefined> | undefined;
        expect(composeEnv).toBeDefined();
        expect(composeEnv!.DOCKER_HOST).toBe('unix:///run/user/1000/docker.sock');
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('getLocalDockerEnv returns a ProcessEnv-shaped object', () => {
      const env = getLocalDockerEnv();
      expect(env).toBeDefined();
      expect(typeof env).toBe('object');
    });

    it('getLocalDockerEnv clears a non-loopback TCP DOCKER_HOST', () => {
      process.env.DOCKER_HOST = 'tcp://192.168.1.100:2375';
      const env = getLocalDockerEnv();
      // Non-loopback TCP must be removed so docker CLI falls back to the local socket
      expect(env.DOCKER_HOST).toBeUndefined();
    });
  });

  describe('runAgentCommand', () => {
    const { getDir } = useTempDir();

    beforeEach(() => {
      containerLifecycleTestHelpers.resetAgentExternallyKilled();
    });

    it('should return exit code from container', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(0);
    });

    it('should return non-zero exit code when command fails', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(1);
    });

    it('should detect blocked domains from access log', async () => {
      // Create access.log with denied entries
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code (command failed)
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(1);
      expect(result.blockedDomains).toContain('blocked.com');
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(getDir(), 'custom-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(proxyLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com'], proxyLogsDir);

      expect(result.blockedDomains).toContain('blocked.com');
    });

    it('should throw error when docker wait fails', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait failure
      mockExecaFn.mockRejectedValueOnce(new Error('Container not found'));

      await expect(runAgentCommand(getDir(), ['github.com'])).rejects.toThrow('Container not found');
    });

    it('should handle blocked domain without port (standard port 443)', async () => {
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 example.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE example.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(1);
      expect(result.blockedDomains).toContain('example.com');
    });

    it('should handle allowed domain in blocklist correctly', async () => {
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // Create a log entry for subdomain of allowed domain
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 api.github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE api.github.com:8443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(1);
      // api.github.com should be blocked because port 8443 is not allowed
      expect(result.blockedDomains).toContain('api.github.com');
    });

    it('should return empty blockedDomains when no access log exists', async () => {
      // Don't create access.log

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      expect(result.exitCode).toBe(0);
      expect(result.blockedDomains).toEqual([]);
    });

    it('should return exit code 124 when agent times out', async () => {
      jest.useFakeTimers();

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait - never resolves (simulates long-running command)
      mockExecaFn.mockReturnValueOnce(new Promise(() => {}));
      // Mock docker stop
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      const resultPromise = runAgentCommand(getDir(), ['github.com'], undefined, 1);

      // Use advanceTimersByTimeAsync to flush microtasks between timer advances
      // This handles the 60s timeout AND the subsequent 500ms log flush delay
      await jest.advanceTimersByTimeAsync(60 * 1000 + 1000);

      const result = await resultPromise;

      expect(result.exitCode).toBe(124);
      // Verify docker stop was called
      expect(mockExecaFn).toHaveBeenCalledWith('docker', ['stop', '-t', '10', 'awf-agent'], expect.objectContaining({ reject: false }));

      jest.useRealTimers();
    });

    it('should return normal exit code when agent completes before timeout', async () => {
      jest.useFakeTimers();

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait - resolves immediately with exit code 0
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

      const resultPromise = runAgentCommand(getDir(), ['github.com'], undefined, 30);

      // Advance past the 500ms log flush delay
      await jest.advanceTimersByTimeAsync(1000);

      const result = await resultPromise;

      expect(result.exitCode).toBe(0);
      expect(result.blockedDomains).toEqual([]);

      jest.useRealTimers();
    });

    it('should skip post-run analysis when agent was externally killed', async () => {
      // Create access.log with denied entries — these should be ignored
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Simulate fastKillAgentContainer having been called
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // fastKill docker stop
      await fastKillAgentContainer();

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait — container was stopped externally, returns 143
      mockExecaFn.mockResolvedValueOnce({ stdout: '143', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(getDir(), ['github.com']);

      // Should return 143 and skip log analysis (empty blockedDomains)
      expect(result.exitCode).toBe(143);
      expect(result.blockedDomains).toEqual([]);
    });

    it('should recognize domains matched by a wildcard allowlist entry', async () => {
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // api.github.com is blocked on a non-standard port
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 api.github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE api.github.com:8443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await runAgentCommand(getDir(), ['*.github.com']);
        // *.github.com covers api.github.com, so the message should report a port issue, not a missing domain
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('port 8443 not allowed'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('domain not in allowlist'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should recognize domains matched by a protocol-prefixed allowlist entry', async () => {
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // github.com is listed as https://github.com; a non-standard port block should show as port issue
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 github.com:8080 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:8080 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await runAgentCommand(getDir(), ['https://github.com']);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('port 8080 not allowed'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('domain not in allowlist'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should deduplicate domains in --allow-domains suggestion', async () => {
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // Same domain blocked on two different ports — should appear once in the suggestion
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 missing.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE missing.com:80 "curl/7.81.0"\n' +
        '1760994430.000 172.30.0.20:36275 missing.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE missing.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await runAgentCommand(getDir(), ['github.com']);
        const suggestionCalls = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === 'string' && msg.includes('--allow-domains')
        );
        expect(suggestionCalls).toHaveLength(1);
        const suggestion = suggestionCalls[0][0] as string;
        // missing.com should appear exactly once in the suggestion
        const occurrences = (suggestion.match(/missing\.com/g) ?? []).length;
        expect(occurrences).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should use logger.warn (not logger.error) for post-run blocked-domain diagnostics', async () => {
      const squidLogsDir = path.join(getDir(), 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      try {
        await runAgentCommand(getDir(), ['github.com']);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('blocked.com'));
        expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('blocked.com'));
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
