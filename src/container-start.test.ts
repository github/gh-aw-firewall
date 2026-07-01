import { startContainers } from './container-lifecycle';
import * as fs from 'fs';
import * as path from 'path';

// Mock execa module
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { mockStartupRetry, expectComposeUpAttempts } from './test-helpers/startup-retry.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

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

  describe('phased startup (onNetworkReady / topology mode)', () => {
    it('starts squid-proxy with --no-deps first, calls onNetworkReady, then runs full bring-up', async () => {
      const callOrder: string[] = [];
      const onNetworkReady = jest.fn().mockImplementation(async () => {
        callOrder.push('onNetworkReady');
      });

      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up --no-deps squid-proxy (Phase 1: create awf-net)
      mockExecaFn.mockImplementationOnce(async () => {
        callOrder.push('compose-up-squid-only');
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      // 3. docker compose up -d (Phase 3: full bring-up)
      mockExecaFn.mockImplementationOnce(async () => {
        callOrder.push('compose-up-full');
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await startContainers(getDir(), ['github.com'], undefined, undefined, onNetworkReady);

      expect(callOrder).toEqual(['compose-up-squid-only', 'onNetworkReady', 'compose-up-full']);
      expect(onNetworkReady).toHaveBeenCalledTimes(1);
    });

    it('uses --no-deps squid-proxy for the first phase', async () => {
      const onNetworkReady = jest.fn().mockResolvedValue(undefined);

      // 1. docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up --no-deps squid-proxy
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 3. docker compose up -d
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com'], undefined, undefined, onNetworkReady);

      const squidOnlyCall = mockExecaFn.mock.calls.find(
        (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('--no-deps')
      );
      expect(squidOnlyCall).toBeDefined();
      expect(squidOnlyCall[1]).toEqual(['compose', 'up', '-d', '--no-deps', 'squid-proxy']);
      expect(squidOnlyCall[2]).toEqual(expect.objectContaining({ cwd: getDir(), stdout: process.stderr }));
    });

    it('applies --pull never to both phases when skipPull is true', async () => {
      const onNetworkReady = jest.fn().mockResolvedValue(undefined);

      // 1. docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up --no-deps squid-proxy --pull never
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 3. docker compose up -d --pull never
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await startContainers(getDir(), ['github.com'], undefined, true, onNetworkReady);

      const squidOnlyCall = mockExecaFn.mock.calls.find(
        (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('--no-deps')
      );
      expect(squidOnlyCall[1]).toEqual(['compose', 'up', '-d', '--no-deps', '--pull', 'never', 'squid-proxy']);

      const fullUpCall = mockExecaFn.mock.calls.find(
        (call: any[]) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1].includes('up') &&
          !call[1].includes('--no-deps')
      );
      expect(fullUpCall[1]).toEqual(['compose', 'up', '-d', '--pull', 'never']);
    });

    it('does not call onNetworkReady when squid-only phase fails', async () => {
      const onNetworkReady = jest.fn().mockResolvedValue(undefined);

      // 1. docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up --no-deps squid-proxy (fails)
      mockExecaFn.mockRejectedValueOnce(new Error('squid phase failed'));

      await expect(
        startContainers(getDir(), ['github.com'], undefined, undefined, onNetworkReady)
      ).rejects.toThrow('squid phase failed');

      expect(onNetworkReady).not.toHaveBeenCalled();
      const fullUpCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1].includes('up') &&
          !call[1].includes('--no-deps')
      );
      expect(fullUpCalls).toHaveLength(0);
    });

    it('retains the api-proxy/squid one-shot retry in the full bring-up phase', async () => {
      const onNetworkReady = jest.fn().mockResolvedValue(undefined);

      // 1. docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up --no-deps squid-proxy (Phase 1 succeeds)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 3. docker compose up -d (Phase 3 first attempt - api-proxy unhealthy)
      mockExecaFn.mockRejectedValueOnce(
        new Error('dependency failed to start: container awf-api-proxy is unhealthy')
      );
      // 4. docker logs awf-api-proxy (diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'api-proxy logs', stderr: '', exitCode: 0 } as any);
      // 5. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 6. docker compose up -d (Phase 3 retry succeeds)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await expect(
        startContainers(getDir(), ['github.com'], undefined, undefined, onNetworkReady)
      ).resolves.toBeUndefined();

      // onNetworkReady called once (between phases 1 and 3)
      expect(onNetworkReady).toHaveBeenCalledTimes(1);
      // Full compose up (without --no-deps) attempted twice (initial + retry)
      const fullUpCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1].includes('up') &&
          !call[1].includes('--no-deps')
      );
      expect(fullUpCalls).toHaveLength(2);
    });
  });
});
