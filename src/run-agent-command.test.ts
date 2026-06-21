import { runAgentCommand, fastKillAgentContainer } from './container-lifecycle';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

// Mock execa module
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

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
    try {
      // Mock docker logs -f
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // Mock docker wait - never resolves (simulates long-running command)
      mockExecaFn.mockReturnValueOnce(new Promise(() => {}));
      // Mock docker stop
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      const resultPromise = runAgentCommand(getDir(), ['github.com'], undefined, 1);

      // Advance past the 60s timeout and the subsequent 200ms Squid-log flush delay
      await jest.advanceTimersByTimeAsync(60 * 1000 + 300);

      const result = await resultPromise;

      expect(result.exitCode).toBe(124);
      // Verify docker stop was called
      expect(mockExecaFn).toHaveBeenCalledWith('docker', ['stop', '-t', '10', 'awf-agent'], expect.objectContaining({ reject: false }));
    } finally {
      jest.useRealTimers();
    }
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
