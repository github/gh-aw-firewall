/**
 * Additional coverage tests for container-lifecycle.ts targeting
 * branches not reached by docker-manager-lifecycle.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { startContainers, runAgentCommand } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { logger } from './logger';

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('container-lifecycle coverage', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), 'test-tmp-' + Date.now());
    fs.mkdirSync(testDir, { recursive: true });
    jest.clearAllMocks();
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('checkSquidLogs - non-numeric port target', () => {
    it('should treat full target as domain when port part is non-numeric', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // Port "abc" fails /^\d+$/ so domain becomes the full target string "noport.com:abc"
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 noport.com:abc -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE noport.com:abc "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const result = await runAgentCommand(testDir, ['github.com']);

      // Full target "noport.com:abc" becomes the domain (no port extracted)
      expect(result.blockedDomains).toContain('noport.com:abc');
    });

    it('should handle a target with no colon (no port at all)', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // No colon in the target - entire string is domain, port is undefined
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 nodomain -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE nodomain "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const result = await runAgentCommand(testDir, ['github.com']);

      expect(result.blockedDomains).toContain('nodomain');
    });
  });

  describe('logContainerLogsToStderr - execa throws (not just non-zero exit)', () => {
    it('should not throw when docker logs call itself throws an error', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up (first attempt - api-proxy unhealthy)
      mockExecaFn.mockRejectedValueOnce(new Error('dependency failed to start: container awf-api-proxy is unhealthy'));
      // 3. docker logs (logContainerLogsToStderr) - execa itself throws
      mockExecaFn.mockRejectedValueOnce(new Error('docker daemon not running'));
      // 4. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 5. docker compose up (retry) - succeeds
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      // Should succeed despite docker logs throwing (best-effort)
      await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();
    });
  });

  describe('didApiProxyFailStartup - docker inspect throws', () => {
    it('should return false (no retry) when docker inspect throws', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up - generic error (not api-proxy specific in message)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 3. docker inspect - throws (e.g. daemon unavailable)
      mockExecaFn.mockRejectedValueOnce(new Error('Cannot connect to Docker daemon'));

      // Since inspect throws, didApiProxyFailStartup returns false → no retry → original error thrown
      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow(
        'Command failed with exit code 1: docker compose up -d'
      );

      // Only one compose up call (no retry)
      const upCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(1);
    });

    it('should return false (no retry) when docker inspect returns non-zero for non-api-proxy error', async () => {
      // 1. docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up - generic error
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 3. docker inspect - non-zero exit code (container not found)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'No such container', exitCode: 1 } as any);

      await expect(startContainers(testDir, ['github.com'])).rejects.toThrow(
        'Command failed with exit code 1: docker compose up -d'
      );

      const upCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(1);
    });

    it('should retry when docker inspect shows api-proxy is unhealthy (health status)', async () => {
      // 1. docker rm
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 2. docker compose up - generic error
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed with exit code 1: docker compose up -d'));
      // 3. docker inspect - returns "running|unhealthy" (health status is unhealthy)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'running|unhealthy', stderr: '', exitCode: 0 } as any);
      // 4. docker logs (diagnosis)
      mockExecaFn.mockResolvedValueOnce({ stdout: 'some logs', stderr: '', exitCode: 0 } as any);
      // 5. docker compose down (cleanup)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // 6. docker compose up (retry) - succeeds
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();

      const upCalls = mockExecaFn.mock.calls.filter(
        (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(2);
    });
  });

  describe('reportBlockedDomains - "other reason" else branch', () => {
    it('should log plain blocked target when domain is allowed but still denied on port 443', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // github.com:443 is "allowed" (in allowlist) but squid still denied it (shouldn't happen
      // often in practice, but exercises the else branch in reportBlockedDomains)
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 github.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await runAgentCommand(testDir, ['github.com']);
        // "other reason" branch: log just the target, no specific message about domain/port
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('github.com:443'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('domain not in allowlist'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('port 443 not allowed'));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should log plain blocked target when domain is allowed and port is 80', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 github.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE github.com:80 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '1', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await runAgentCommand(testDir, ['github.com']);
        // domain is allowed, port is 80 (standard) - falls into "other reason" else
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('github.com:80'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('domain not in allowlist'));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('port 80 not allowed'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('runAgentCommand - no blocked domains when exit code is 0', () => {
    it('should not log warning when domains are blocked but exit code is 0', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // Squid log shows blocked domains, but agent succeeded (exit 0)
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '0', stderr: '', exitCode: 0 } as any); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const result = await runAgentCommand(testDir, ['github.com']);
        // blockedDomains still returned even on exit 0
        expect(result.blockedDomains).toContain('blocked.com');
        // But no warning logged (warning only fires on non-zero exit)
        expect(warnSpy).not.toHaveBeenCalledWith('Firewall blocked domains:');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
