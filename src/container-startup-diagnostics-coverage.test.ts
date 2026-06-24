/**
 * Direct unit tests for container-startup-diagnostics.ts covering functions
 * that were previously only reached indirectly through container-lifecycle tests.
 *
 * Covers:
 *  - didContainerFailStartup: all error-message and inspect branches
 *  - logContainerLogsToStderr: success, empty output, non-zero exit, thrown error
 *  - handleHealthcheckError: blocked-domain path, no-denial rethrow, non-matching rethrow
 *  - reportBlockedDomains: additional branches (empty list, wildcard, protocol mismatch,
 *    "else" path, no missing-domain/port/protocol fix messages when irrelevant)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./squid-log-reader');

import {
  didContainerFailStartup,
  logContainerLogsToStderr,
  handleHealthcheckError,
  reportBlockedDomains,
} from './container-startup-diagnostics';
import { logger } from './logger';
import { checkSquidLogs } from './squid-log-reader';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';

const mockCheckSquidLogs = jest.mocked(checkSquidLogs);

function execaOk(stdout = '', stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckSquidLogs.mockResolvedValue({ hasDenials: false, blockedTargets: [] });
});

// ─── didContainerFailStartup ──────────────────────────────────────────────────

describe('didContainerFailStartup', () => {
  describe('direct error-message matching (no inspect call needed)', () => {
    it('returns true when error includes container name and "is unhealthy"', async () => {
      const result = await didContainerFailStartup(
        'dependency failed to start: container awf-squid is unhealthy',
        'awf-squid'
      );
      expect(result).toBe(true);
      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('returns true when error includes container name and "exited (1)"', async () => {
      const result = await didContainerFailStartup(
        'container awf-api-proxy exited (1)',
        'awf-api-proxy'
      );
      expect(result).toBe(true);
      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('falls through to inspect when error does not include the container name+keyword combo', async () => {
      // isContainerStartupFailureError returns false (no match), so inspect is still called
      mockExecaFn.mockResolvedValueOnce(execaOk('running|healthy'));
      const result = await didContainerFailStartup(
        'is unhealthy and exited (1) something',
        'awf-squid'
      );
      expect(result).toBe(false);
      // Inspect IS called as the fallback probe
      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['inspect', 'awf-squid']),
        expect.any(Object)
      );
    });
  });

  describe('docker inspect fallback', () => {
    it('returns true when inspect shows containerStatus === "exited"', async () => {
      mockExecaFn.mockResolvedValueOnce(execaOk('exited|'));
      const result = await didContainerFailStartup('generic compose error', 'awf-agent');
      expect(result).toBe(true);
    });

    it('returns true when inspect shows healthStatus === "unhealthy"', async () => {
      mockExecaFn.mockResolvedValueOnce(execaOk('running|unhealthy'));
      const result = await didContainerFailStartup('generic compose error', 'awf-squid');
      expect(result).toBe(true);
    });

    it('returns false when inspect shows container is running and healthy', async () => {
      mockExecaFn.mockResolvedValueOnce(execaOk('running|healthy'));
      const result = await didContainerFailStartup('some unrelated error', 'awf-squid');
      expect(result).toBe(false);
    });

    it('returns false when inspect exits with non-zero (container does not exist)', async () => {
      mockExecaFn.mockResolvedValueOnce(execaOk('', 'No such container', 1));
      const result = await didContainerFailStartup('generic error', 'awf-missing');
      expect(result).toBe(false);
    });

    it('returns false when inspect throws an exception', async () => {
      mockExecaFn.mockRejectedValueOnce(new Error('docker daemon not reachable'));
      const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
      const result = await didContainerFailStartup('generic error', 'awf-squid');
      expect(result).toBe(false);
      debugSpy.mockRestore();
    });

    it('returns false when inspect output is empty/malformed', async () => {
      mockExecaFn.mockResolvedValueOnce(execaOk(''));
      const result = await didContainerFailStartup('generic error', 'awf-squid');
      // containerStatus = '' and healthStatus = '' → neither 'exited' nor 'unhealthy'
      expect(result).toBe(false);
    });
  });
});

// ─── logContainerLogsToStderr ─────────────────────────────────────────────────

describe('logContainerLogsToStderr', () => {
  it('emits container logs to logger.error when docker logs succeeds with output', async () => {
    mockExecaFn.mockResolvedValueOnce(execaOk('log line 1\nlog line 2', '', 0));
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await logContainerLogsToStderr('awf-api-proxy');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('awf-api-proxy container logs')
    );
    expect(errorSpy.mock.calls[0][0]).toContain('log line 1');
    errorSpy.mockRestore();
  });

  it('includes stderr output in combined log emission', async () => {
    mockExecaFn.mockResolvedValueOnce(execaOk('', 'stderr line', 0));
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await logContainerLogsToStderr('awf-squid');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stderr line'));
    errorSpy.mockRestore();
  });

  it('does not emit logger.error when docker logs returns empty output', async () => {
    mockExecaFn.mockResolvedValueOnce(execaOk('', '', 0));
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await logContainerLogsToStderr('awf-squid');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits a debug message when docker logs exits with non-zero code', async () => {
    mockExecaFn.mockResolvedValueOnce(execaOk('', 'No such container', 1));
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    await logContainerLogsToStderr('awf-missing');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('1'));
    debugSpy.mockRestore();
  });

  it('silently swallows exceptions and emits a debug message', async () => {
    mockExecaFn.mockRejectedValueOnce(new Error('docker CLI not found'));
    const debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    await expect(logContainerLogsToStderr('awf-squid')).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('awf-squid'),
      expect.any(Error)
    );
    debugSpy.mockRestore();
  });
});

// ─── handleHealthcheckError ───────────────────────────────────────────────────

describe('handleHealthcheckError', () => {
  it('throws a user-friendly blocked-domain error when squid logs show denials', async () => {
    mockCheckSquidLogs.mockResolvedValueOnce({
      hasDenials: true,
      blockedTargets: [{ target: 'evil.com:443', domain: 'evil.com', port: '443' }],
    });
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      handleHealthcheckError(
        'Service is unhealthy',
        new Error('original'),
        '/tmp/test-workdir',
        undefined,
        ['github.com']
      )
    ).rejects.toThrow('Firewall blocked access to: "evil.com:443"');

    errorSpy.mockRestore();
  });

  it('triggers on "dependency failed" keyword in error message', async () => {
    mockCheckSquidLogs.mockResolvedValueOnce({
      hasDenials: true,
      blockedTargets: [{ target: 'blocked.io:80', domain: 'blocked.io', port: '80' }],
    });
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      handleHealthcheckError(
        'dependency failed to start: container is unhealthy',
        new Error('original'),
        '/tmp/test-workdir',
        undefined,
        []
      )
    ).rejects.toThrow('Firewall blocked access to:');

    errorSpy.mockRestore();
  });

  it('rethrows the original error when squid logs show no denials', async () => {
    mockCheckSquidLogs.mockResolvedValueOnce({ hasDenials: false, blockedTargets: [] });
    const originalError = new Error('healthcheck timed out');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      handleHealthcheckError(
        'Service is unhealthy',
        originalError,
        '/tmp/test-workdir',
        undefined,
        []
      )
    ).rejects.toThrow('healthcheck timed out');

    errorSpy.mockRestore();
  });

  it('rethrows the original error when error message does not contain health keywords', async () => {
    const originalError = new Error('network timeout');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      handleHealthcheckError(
        'network timeout',
        originalError,
        '/tmp/test-workdir',
        undefined,
        ['github.com']
      )
    ).rejects.toThrow('network timeout');

    // checkSquidLogs should NOT be called when keywords don't match
    expect(mockCheckSquidLogs).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('passes proxyLogsDir to checkSquidLogs when provided', async () => {
    mockCheckSquidLogs.mockResolvedValueOnce({ hasDenials: false, blockedTargets: [] });
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      handleHealthcheckError(
        'is unhealthy',
        new Error('original'),
        '/tmp/workdir',
        '/custom/proxy-logs',
        []
      )
    ).rejects.toThrow('original');

    expect(mockCheckSquidLogs).toHaveBeenCalledWith('/tmp/workdir', '/custom/proxy-logs');
    errorSpy.mockRestore();
  });
});

// ─── reportBlockedDomains – additional branches ───────────────────────────────

describe('reportBlockedDomains – additional branches', () => {
  it('emits no blocked messages and lists all allowed domains when no targets are blocked', () => {
    const messages: string[] = [];
    const result = reportBlockedDomains([], ['github.com', 'npmjs.org'], msg => messages.push(msg));
    expect(result).toEqual({ missingDomains: [], portIssues: [], protocolIssues: [] });
    expect(messages).toContain('Allowed domains:');
    expect(messages).toContain('  - Allowed: github.com');
    expect(messages).toContain('  - Allowed: npmjs.org');
    // No fix suggestion when nothing was blocked
    const fixMessages = messages.filter(m => m.startsWith('To fix'));
    expect(fixMessages).toHaveLength(0);
  });

  it('matches wildcard allowlist entry against subdomain targets', () => {
    const messages: string[] = [];
    const result = reportBlockedDomains(
      [{ target: 'api.github.com:443', domain: 'api.github.com', port: '443' }],
      ['*.github.com'],
      msg => messages.push(msg)
    );
    // The wildcard covers api.github.com — no missing-domain entry
    expect(result.missingDomains).toHaveLength(0);
  });

  it('hits the "else" branch (allowed domain, standard port, matching protocol)', () => {
    const messages: string[] = [];
    // github.com is in allowlist (protocol = 'both'), port = '443' (blockedProtocol = 'https')
    // → isAllowed = true (allowed.protocol === 'both'), port is standard → else branch
    reportBlockedDomains(
      [{ target: 'github.com:443', domain: 'github.com', port: '443' }],
      ['github.com'],
      msg => messages.push(msg)
    );
    // The else branch emits "  - Blocked: github.com:443" with no extra annotation
    expect(messages).toContain('  - Blocked: github.com:443');
    const blockedMsg = messages.find(m => m.includes('github.com:443'));
    expect(blockedMsg).not.toContain('not in allowlist');
    expect(blockedMsg).not.toContain('not allowed');
    expect(blockedMsg).not.toContain('protocol');
  });

  it('classifies protocol mismatch for https-only domain blocked on http', () => {
    const messages: string[] = [];
    const result = reportBlockedDomains(
      [{ target: 'example.com:80', domain: 'example.com', port: '80' }],
      ['https://example.com'],
      msg => messages.push(msg)
    );
    expect(result.protocolIssues).toHaveLength(1);
    expect(messages).toContain('  - Blocked: example.com:80 (protocol not allowed by allowlist entry)');
    expect(messages).toContain('To fix protocol issues: add an allowlist entry for the correct protocol (http://domain or https://domain), or allow both by using the bare domain');
  });

  it('handles multiple missing domains and deduplicates them in the fix message', () => {
    const messages: string[] = [];
    const result = reportBlockedDomains(
      [
        { target: 'a.missing.com:443', domain: 'a.missing.com', port: '443' },
        // Same domain, different port — still only one unique missing domain
        { target: 'a.missing.com:443', domain: 'a.missing.com', port: '443' },
        { target: 'b.missing.com:80', domain: 'b.missing.com', port: '80' },
      ],
      ['github.com'],
      msg => messages.push(msg)
    );
    expect(result.missingDomains).toHaveLength(2);
    expect(result.missingDomains).toContain('a.missing.com');
    expect(result.missingDomains).toContain('b.missing.com');
    // Fix message should list both missing domains
    const fixMsg = messages.find(m => m.startsWith('To fix domain issues:'));
    expect(fixMsg).toContain('a.missing.com');
    expect(fixMsg).toContain('b.missing.com');
  });

  it('does not emit port-fix or protocol-fix messages when only domain issues exist', () => {
    const messages: string[] = [];
    reportBlockedDomains(
      [{ target: 'unknown.com:443', domain: 'unknown.com', port: '443' }],
      ['github.com'],
      msg => messages.push(msg)
    );
    const fixMessages = messages.filter(m => m.startsWith('To fix'));
    expect(fixMessages).toHaveLength(1);
    expect(fixMessages[0]).toContain('domain issues');
  });

  it('handles targets with undefined port (blockedProtocol = "both")', () => {
    const messages: string[] = [];
    const result = reportBlockedDomains(
      [{ target: 'missing.com', domain: 'missing.com', port: undefined }],
      ['github.com'],
      msg => messages.push(msg)
    );
    // No port → domain still not in allowlist
    expect(result.missingDomains).toContain('missing.com');
  });

  it('emits a fix suggestion that includes both existing and missing domains', () => {
    const messages: string[] = [];
    reportBlockedDomains(
      [{ target: 'newsite.io:443', domain: 'newsite.io', port: '443' }],
      ['existing.com'],
      msg => messages.push(msg)
    );
    const fixMsg = messages.find(m => m.startsWith('To fix domain issues:'));
    expect(fixMsg).toContain('existing.com');
    expect(fixMsg).toContain('newsite.io');
  });
});
