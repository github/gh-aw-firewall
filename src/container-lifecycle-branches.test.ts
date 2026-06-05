/**
 * Targeted branch-coverage tests for container-lifecycle.ts.
 *
 * These tests cover paths not exercised by docker-manager-lifecycle.test.ts:
 *  - reportBlockedDomains "else" branch (domain allowed, standard port, other reason)
 *  - checkSquidLogs IPv6 target with non-numeric trailing segment
 *  - checkSquidLogs with no TCP_DENIED entries (empty log coverage)
 *  - didContainerFailStartup with healthStatus === 'unhealthy' from inspect output
 */

import { startContainers, runAgentCommand } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

function makeExecaResult(stdout = '', stderr = '', exitCode = 0): any {
  return { stdout, stderr, exitCode };
}

describe('container-lifecycle uncovered branches', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
    jest.clearAllMocks();
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ─── reportBlockedDomains "else" branch ──────────────────────────────────────
  // This branch is hit when the domain IS in the allowlist but blocked on a
  // standard port (80 or 443). Squid shouldn't normally produce this combination,
  // but the code handles it as "Other reason (shouldn't happen often)".

  describe('reportBlockedDomains - allowed domain on standard port', () => {
    it('should log generic blocked message when allowed domain is blocked on port 443', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // github.com:443 — domain IS in the allowlist, port IS standard
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 github.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce(makeExecaResult()); // docker logs -f
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('1')); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const result = await runAgentCommand(testDir, ['github.com']);
        expect(result.exitCode).toBe(1);
        // The "else" branch emits "Blocked: github.com:443" without extra context
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('  - Blocked: github.com:443'));
        // Should NOT say "domain not in allowlist" or "port ... not allowed"
        const allWarnings = warnSpy.mock.calls.map(([m]) => m).join('\n');
        expect(allWarnings).not.toContain('domain not in allowlist');
        expect(allWarnings).not.toContain('not allowed');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should log generic blocked message when allowed domain is blocked on port 80', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 github.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE github.com:80 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce(makeExecaResult()); // docker logs -f
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('1')); // docker wait

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await runAgentCommand(testDir, ['github.com']);
        // "else" branch — generic message, no port complaint
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('  - Blocked: github.com:80'));
        const allWarnings = warnSpy.mock.calls.map(([m]) => m).join('\n');
        expect(allWarnings).not.toContain('port 80 not allowed');
        expect(allWarnings).not.toContain('domain not in allowlist');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ─── checkSquidLogs IPv6 target parsing ─────────────────────────────────────
  // When a Squid log entry contains an IPv6 address, the simple lastIndexOf(':')
  // trick extracts a non-numeric "port", triggering the fallback that treats the
  // entire target string as the domain with no port.

  describe('checkSquidLogs - IPv6 targets', () => {
    it('should handle IPv6 target where extracted "port" is non-numeric', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // Simulate an IPv6 address without a numeric port suffix; the last segment
      // after ':' would be something like "abc" (non-numeric) so the code falls
      // back to domain = target, port = undefined.
      // E.g. target = "2001:db8::abc" → lastIndexOf(':') → segment "abc" (non-numeric)
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 2001:db8::abc -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE 2001:db8::abc "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce(makeExecaResult()); // docker logs -f
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('1')); // docker wait

      const result = await runAgentCommand(testDir, []);
      expect(result.exitCode).toBe(1);
      // The full IPv6 target is treated as the domain (no port extracted)
      expect(result.blockedDomains).toContain('2001:db8::abc');
    });

    it('should correctly parse bracketed IPv6 target with port', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // [::1]:443 — port after last ':' is "443" (numeric), so domain = "[::1]", port = "443"
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 [::1]:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE [::1]:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce(makeExecaResult()); // docker logs -f
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('1')); // docker wait

      const result = await runAgentCommand(testDir, []);
      expect(result.exitCode).toBe(1);
      // Domain should be "[::1]" without the port
      expect(result.blockedDomains).toContain('[::1]');
    });
  });

  // ─── checkSquidLogs - no denied entries ──────────────────────────────────────

  describe('checkSquidLogs - log with only allowed entries', () => {
    it('should return empty blockedDomains when log has TCP_TUNNEL entries only', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      // TCP_TUNNEL (allowed) — no TCP_DENIED lines
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 github.com:443 -:- 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT github.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce(makeExecaResult()); // docker logs -f
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('0')); // docker wait — success

      const result = await runAgentCommand(testDir, ['github.com']);
      expect(result.exitCode).toBe(0);
      expect(result.blockedDomains).toEqual([]);
    });
  });

  // ─── didApiProxyFailStartup - healthStatus === 'unhealthy' from inspect ──────
  // This covers the branch where docker inspect returns "running|unhealthy" (health
  // check is failing while container is still alive), which also triggers the retry.

  describe('startContainers - api-proxy unhealthy via inspect health status', () => {
    it('should retry when docker inspect reports running but unhealthy health status', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce(makeExecaResult());
      // 2. docker compose up (first attempt — generic error, not api-proxy in message)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed: docker compose up -d'));
      // 3. docker inspect awf-api-proxy → "running|unhealthy"
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('running|unhealthy'));
      // 4. docker logs (diagnosis before retry)
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('api-proxy logs'));
      // 5. docker compose down (cleanup before retry)
      mockExecaFn.mockResolvedValueOnce(makeExecaResult());
      // 6. docker compose up (retry — succeeds)
      mockExecaFn.mockResolvedValueOnce(makeExecaResult());

      await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();

      // Confirm two compose-up calls were made (initial + retry)
      const upCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(2);
    });

    describe('startContainers - squid unhealthy via inspect health status', () => {
      it('should retry when docker inspect reports squid running but unhealthy', async () => {
        // 1. docker rm (initial cleanup)
        mockExecaFn.mockResolvedValueOnce(makeExecaResult());
        // 2. docker compose up (first attempt — generic error)
        mockExecaFn.mockRejectedValueOnce(new Error('Command failed: docker compose up -d'));
        // 3. docker inspect awf-api-proxy -> healthy (not the failing container)
        mockExecaFn.mockResolvedValueOnce(makeExecaResult('running|healthy'));
        // 4. docker inspect awf-squid -> "running|unhealthy"
        mockExecaFn.mockResolvedValueOnce(makeExecaResult('running|unhealthy'));
        // 5. docker logs (diagnosis before retry)
        mockExecaFn.mockResolvedValueOnce(makeExecaResult('squid logs'));
        // 6. docker compose down (cleanup before retry)
        mockExecaFn.mockResolvedValueOnce(makeExecaResult());
        // 7. docker compose up (retry — succeeds)
        mockExecaFn.mockResolvedValueOnce(makeExecaResult());

        await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();

        const squidInspectCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
          call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'inspect' && call[1][1] === 'awf-squid'
        );
        expect(squidInspectCalls).toHaveLength(1);

        const upCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
          call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
        );
        expect(upCalls).toHaveLength(2);
      });
    });

    it('should retry when docker inspect reports exited|unhealthy', async () => {
      // 1. docker rm (initial cleanup)
      mockExecaFn.mockResolvedValueOnce(makeExecaResult());
      // 2. docker compose up (first attempt — generic error)
      mockExecaFn.mockRejectedValueOnce(new Error('Command failed: docker compose up -d'));
      // 3. docker inspect awf-api-proxy → "exited|unhealthy"
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('exited|unhealthy'));
      // 4. docker logs
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('api-proxy logs'));
      // 5. docker compose down
      mockExecaFn.mockResolvedValueOnce(makeExecaResult());
      // 6. docker compose up (retry — succeeds)
      mockExecaFn.mockResolvedValueOnce(makeExecaResult());

      await expect(startContainers(testDir, ['github.com'])).resolves.toBeUndefined();

      const upCalls = mockExecaFn.mock.calls.filter((call: any[]) =>
        call[0] === 'docker' && Array.isArray(call[1]) && call[1].includes('up')
      );
      expect(upCalls).toHaveLength(2);
    });
  });

  // ─── runAgentCommand - exit code 0 with blocked domains (no warning) ─────────
  // When exit code is 0 but there are denied entries, the blocked-domains warning
  // should NOT be emitted (only non-zero exits trigger it).

  describe('runAgentCommand - zero exit code suppresses blocked-domain warning', () => {
    it('should not warn about blocked domains when exit code is 0', async () => {
      const squidLogsDir = path.join(testDir, 'squid-logs');
      fs.mkdirSync(squidLogsDir, { recursive: true });
      fs.writeFileSync(
        path.join(squidLogsDir, 'access.log'),
        '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n'
      );

      mockExecaFn.mockResolvedValueOnce(makeExecaResult()); // docker logs -f
      mockExecaFn.mockResolvedValueOnce(makeExecaResult('0')); // docker wait — exit 0

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const result = await runAgentCommand(testDir, ['github.com']);
        expect(result.exitCode).toBe(0);
        // Blocked domains are still returned but no user-facing warning is emitted
        expect(result.blockedDomains).toContain('blocked.com');
        const warningsAboutBlocked = warnSpy.mock.calls.filter(([m]) =>
          typeof m === 'string' && m.toLowerCase().includes('blocked')
        );
        expect(warningsAboutBlocked).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
