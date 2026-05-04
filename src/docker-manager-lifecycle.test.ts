import { startContainers, stopContainers, fastKillAgentContainer, isAgentExternallyKilled, resetAgentExternallyKilled, AGENT_CONTAINER_NAME, runAgentCommand, setAwfDockerHost } from './docker-manager';
import { WrapperConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions
const mockExecaFn = jest.fn();
const mockExecaSync = jest.fn();

// Mock execa module
jest.mock('execa', () => {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
});

describe('docker-manager lifecycle', () => {
  describe('startContainers', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should remove existing containers before starting', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com']);

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

      await startContainers(testDir, ['github.com']);

      // Should still call docker compose up even if rm failed
      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        expect.objectContaining({ cwd: testDir, stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should run docker compose up', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com']);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        expect.objectContaining({ cwd: testDir, stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should run docker compose up with --pull never when skipPull is true', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com'], undefined, true);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d', '--pull', 'never'],
        expect.objectContaining({ cwd: testDir, stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should run docker compose up without --pull never when skipPull is false', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(testDir, ['github.com'], undefined, false);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'up', '-d'],
        expect.objectContaining({ cwd: testDir, stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should handle docker compose failure', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockRejectedValueOnce(new Error('Docker compose failed'));

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow('Docker compose failed');
    });

    it('should handle healthcheck failure with blocked domains', async () => {
      // Create access.log with denied entries
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockRejectedValueOnce(new Error('is unhealthy'));

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow();
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

      await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();

      // Verify retry happened: compose up was called twice
      const upCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(2);
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

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow(
        'AWF firewall failed to start: awf-api-proxy failed its health check on both attempts'
      );
    });

    it('should not retry for non-api-proxy healthcheck failures', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (fails with squid unhealthy - not api-proxy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-squid is unhealthy'));

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow();

      // Only one compose up call (no retry)
      const upCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(1);
    });

    it('should route retry error through Squid diagnostics when retry fails with non-api-proxy error', async () => {
      // Create access.log with denied entries so Squid diagnostics fire
      const squidLogsDir = path.join(testDir, 'squid-logs');
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

      // Should surface the Squid blocked-domain error, not a raw throw
      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow('Firewall blocked access to:');
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
      await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();
    });
  });

  describe('stopContainers', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should skip stopping when keepContainers is true', async () => {
      await stopContainers(testDir, true);

      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('should run docker compose down when keepContainers is false', async () => {
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await stopContainers(testDir, false);

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['compose', 'down', '-v', '-t', '1'],
        expect.objectContaining({ cwd: testDir, stdout: process.stderr, stderr: 'inherit' })
      );
    });

    it('should throw error when docker compose down fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('Docker compose down failed'));

      await expect(stopContainers(testDir, false)).rejects.toThrow('Docker compose down failed');
    });
  });

  describe('fastKillAgentContainer', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      resetAgentExternallyKilled();
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

      expect(isAgentExternallyKilled()).toBe(false);
      await fastKillAgentContainer();
      expect(isAgentExternallyKilled()).toBe(true);
    });

    it('should set the externally-killed flag even when docker stop fails', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('docker not found'));

      await fastKillAgentContainer();
      expect(isAgentExternallyKilled()).toBe(true);
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

    it('docker compose up should NOT forward a TCP DOCKER_HOST to the docker CLI', async () => {
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
        // DOCKER_HOST must be absent from the env passed to docker compose
        expect(composeEnv).toBeDefined();
        expect(composeEnv!.DOCKER_HOST).toBeUndefined();
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
      process.env.DOCKER_HOST = 'tcp://localhost:2375'; // Would normally be cleared
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
  });

  describe('runAgentCommand', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
      jest.clearAllMocks();
      resetAgentExternallyKilled();
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should return exit code from container', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(0);
    });

    it('should return non-zero exit code when command fails', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
    });

    it('should detect blocked domains from access log', async () => {
      // Create access.log with denied entries
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code (command failed)
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
      expect(result.blockedDomains).toContain('blocked.com');
    });

    it('should use proxyLogsDir when specified', async () => {
      const proxyLogsDir = path.join(testDir, 'custom-logs');
      fs.mkdirSync(proxyLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(proxyLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com'], proxyLogsDir);

      expect(result.blockedDomains).toContain('blocked.com');
    });

    it('should throw error when docker wait fails', async () => {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait failure
      mockExecaFn.mockRejectedValueOnce(new Error('Container not found'));

      await expect(runAgentCommand(testDir, ['github.com'])).rejects.toThrow('Container not found');
    });

    it('should handle blocked domain without port (standard port 443)', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 example.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE example.com:443 "curl/7.81.0"\n'
      );

      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait with non-zero exit code
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any);

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.exitCode).toBe(1);
      expect(result.blockedDomains).toContain('example.com');
    });

    it('should handle allowed domain in blocklist correctly', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
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

      const result = await runAgentCommand(testDir, ['github.com']);

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

      const result = await runAgentCommand(testDir, ['github.com']);

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

      const resultPromise = runAgentCommand(testDir, ['github.com'], undefined, 1);

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

      const resultPromise = runAgentCommand(testDir, ['github.com'], undefined, 30);

      // Advance past the 500ms log flush delay
      await jest.advanceTimersByTimeAsync(1000);

      const result = await resultPromise;

      expect(result.exitCode).toBe(0);
      expect(result.blockedDomains).toEqual([]);

      jest.useRealTimers();
    });

    it('should skip post-run analysis when agent was externally killed', async () => {
      // Create access.log with denied entries — these should be ignored
      const squidLogsDir = path.join(testDir, 'squid-logs');
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

      const result = await runAgentCommand(testDir, ['github.com']);

      // Should return 143 and skip log analysis (empty blockedDomains)
      expect(result.exitCode).toBe(143);
      expect(result.blockedDomains).toEqual([]);
    });
  });
});
