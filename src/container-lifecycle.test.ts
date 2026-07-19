/**
 * Unit tests for container-lifecycle.ts
 *
 * Covers: startContainers, runAgentCommand, fastKillAgentContainer
 * Uses jest.mock() for all Docker/execa/fs dependencies.
 */

import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

jest.mock('./host-env', () => ({
  ...jest.requireActual('./host-env'),
  getSafeHostUid: () => '1000',
  getSafeHostGid: () => '1000',
}));

jest.mock('./docker-host', () => ({
  getLocalDockerEnv: () => ({}),
}));

jest.mock('./logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock('./container-stop', () => ({
  runComposeDown: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./container-startup-diagnostics', () => ({
  didContainerFailStartup: jest.fn().mockResolvedValue(false),
  handleHealthcheckError: jest.fn().mockResolvedValue(undefined),
  logContainerLogsToStderr: jest.fn().mockResolvedValue(undefined),
  reportBlockedDomains: jest.fn(),
  detectDnsResolutionFailure: jest.fn().mockResolvedValue(null),
}));

jest.mock('./squid-log-reader', () => ({
  checkSquidLogs: jest.fn().mockResolvedValue({ hasDenials: false, blockedTargets: [] }),
}));

jest.mock('./container-lifecycle-state', () => {
  let killed = false;
  return {
    markAgentExternallyKilled: jest.fn(() => { killed = true; }),
    isAgentExternallyKilled: jest.fn(() => killed),
    containerLifecycleStateTestHelpers: { resetAgentExternallyKilled: () => { killed = false; } },
  };
});

import {
  startContainers,
  runAgentCommand,
  fastKillAgentContainer,
} from './container-lifecycle';
import {
  didContainerFailStartup,
  handleHealthcheckError,
  logContainerLogsToStderr,
  detectDnsResolutionFailure,
} from './container-startup-diagnostics';
import { checkSquidLogs } from './squid-log-reader';
import { runComposeDown } from './container-stop';
import { isAgentExternallyKilled, markAgentExternallyKilled, containerLifecycleStateTestHelpers } from './container-lifecycle-state';

const mockDidContainerFailStartup = didContainerFailStartup as jest.MockedFunction<typeof didContainerFailStartup>;
const mockHandleHealthcheckError = handleHealthcheckError as jest.MockedFunction<typeof handleHealthcheckError>;
const mockLogContainerLogsToStderr = logContainerLogsToStderr as jest.MockedFunction<typeof logContainerLogsToStderr>;
const mockDetectDnsResolutionFailure = detectDnsResolutionFailure as jest.MockedFunction<typeof detectDnsResolutionFailure>;
const mockCheckSquidLogs = checkSquidLogs as jest.MockedFunction<typeof checkSquidLogs>;
const mockRunComposeDown = runComposeDown as jest.MockedFunction<typeof runComposeDown>;
const mockIsAgentExternallyKilled = isAgentExternallyKilled as jest.MockedFunction<typeof isAgentExternallyKilled>;
const mockMarkAgentExternallyKilled = markAgentExternallyKilled as jest.MockedFunction<typeof markAgentExternallyKilled>;

const WORK_DIR = '/tmp/awf-test';

beforeEach(() => {
  jest.resetAllMocks();
  containerLifecycleStateTestHelpers.resetAgentExternallyKilled();
  // Default: execa succeeds
  mockExecaFn.mockResolvedValue({ stdout: '0', stderr: '', exitCode: 0 });
  mockDidContainerFailStartup.mockResolvedValue(false);
  mockIsAgentExternallyKilled.mockReturnValue(false);
  mockCheckSquidLogs.mockResolvedValue({ hasDenials: false, blockedTargets: [] });
  mockRunComposeDown.mockResolvedValue(undefined);
  mockHandleHealthcheckError.mockRejectedValue(new Error('healthcheck failed'));
  mockLogContainerLogsToStderr.mockResolvedValue(undefined);
  mockDetectDnsResolutionFailure.mockResolvedValue(null);
});

// ─── startContainers ─────────────────────────────────────────────────────────

describe('startContainers', () => {
  it('starts containers successfully when compose up succeeds', async () => {
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await expect(startContainers(WORK_DIR, ['github.com'])).resolves.toBeUndefined();
    // Should have called docker rm -f and docker compose up
    expect(mockExecaFn).toHaveBeenCalledWith('docker', expect.arrayContaining(['rm', '-f']), expect.any(Object));
    expect(mockExecaFn).toHaveBeenCalledWith('docker', expect.arrayContaining(['compose', 'up', '-d']), expect.any(Object));
  });

  it('passes --pull never when skipPull is true', async () => {
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await startContainers(WORK_DIR, [], undefined, true);
    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', 'up', '-d', '--pull', 'never']),
      expect.any(Object),
    );
  });

  it('delegates to handleHealthcheckError when compose up fails and no specific container failed', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('compose failed')); // compose up
    mockDidContainerFailStartup.mockResolvedValue(false);

    await expect(startContainers(WORK_DIR, ['github.com'])).rejects.toThrow('healthcheck failed');
    expect(mockHandleHealthcheckError).toHaveBeenCalled();
  });

  it('retries when api-proxy fails to start on first attempt', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('awf-api-proxy is unhealthy')) // first compose up
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // retry compose up

    mockDidContainerFailStartup.mockImplementation(async (_msg, name) => {
      return name === 'awf-api-proxy';
    });

    await startContainers(WORK_DIR, []);
    // rm -f + first compose up (fails) + retry compose up = 3 calls
    expect(mockExecaFn).toHaveBeenCalledTimes(3);
    expect(mockRunComposeDown).toHaveBeenCalled();
  });

  it('retries when squid fails to start on first attempt', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('awf-squid is unhealthy')) // first compose up
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }); // retry compose up

    mockDidContainerFailStartup.mockImplementation(async (_msg, name) => {
      return name === 'awf-squid';
    });

    await startContainers(WORK_DIR, []);
    expect(mockExecaFn).toHaveBeenCalledTimes(3);
    expect(mockRunComposeDown).toHaveBeenCalled();
  });

  it('throws specific error when cli-proxy fails to start', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('awf-cli-proxy is unhealthy')); // compose up

    mockDidContainerFailStartup.mockImplementation(async (msg, name) => {
      return name === 'awf-cli-proxy';
    });

    await expect(startContainers(WORK_DIR, [])).rejects.toThrow(/awf-cli-proxy could not connect/);
  });

  it('includes DNS failure detail when cli-proxy fails with EAI_AGAIN', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('awf-cli-proxy is unhealthy')); // compose up

    mockDidContainerFailStartup.mockImplementation(async (msg, name) => name === 'awf-cli-proxy');
    mockDetectDnsResolutionFailure.mockResolvedValue('my-service.svc.cluster.local');

    await expect(startContainers(WORK_DIR, [])).rejects.toThrow(/my-service\.svc\.cluster\.local/);
  });

  it('calls onNetworkReady callback in topology mode', async () => {
    const onNetworkReady = jest.fn().mockResolvedValue(undefined);
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await startContainers(WORK_DIR, [], undefined, false, onNetworkReady);
    expect(onNetworkReady).toHaveBeenCalled();
    // Should have called squid-only up first, then full up
    const execaCalls = mockExecaFn.mock.calls.filter(c => c[0] === 'docker' && c[1].includes('compose'));
    const squidOnlyCall = execaCalls.find(c => c[1].includes('squid-proxy') && c[1].includes('--no-deps'));
    expect(squidOnlyCall).toBeDefined();
  });

  it('throws api-proxy error on second failure when retry fails with api-proxy', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('awf-api-proxy is unhealthy')) // first compose up
      .mockRejectedValueOnce(new Error('awf-api-proxy is unhealthy')); // retry compose up

    mockDidContainerFailStartup.mockImplementation(async (_msg, name) => name === 'awf-api-proxy');

    await expect(startContainers(WORK_DIR, [])).rejects.toThrow(/awf-api-proxy failed to start/);
  });

  it('throws cli-proxy error on second failure when retry fails with cli-proxy', async () => {
    mockExecaFn
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // docker rm -f
      .mockRejectedValueOnce(new Error('awf-squid is unhealthy')) // first compose up
      .mockRejectedValueOnce(new Error('awf-cli-proxy is unhealthy')); // retry compose up

    mockDidContainerFailStartup.mockImplementation(async (msg, name) => {
      if (msg.includes('awf-squid')) return name === 'awf-squid';
      if (msg.includes('awf-cli-proxy')) return name === 'awf-cli-proxy';
      return false;
    });

    await expect(startContainers(WORK_DIR, [])).rejects.toThrow(/awf-cli-proxy could not connect/);
  });
});

// ─── runAgentCommand ──────────────────────────────────────────────────────────

describe('runAgentCommand', () => {
  function makeAgentExecaMock(exitCodeStr: string) {
    return mockExecaFn.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('-f')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: exitCodeStr, stderr: '', exitCode: 0 });
    });
  }

  it('returns exit code 0 when agent exits successfully', async () => {
    makeAgentExecaMock('0');
    const result = await runAgentCommand(WORK_DIR, ['github.com']);
    expect(result.exitCode).toBe(0);
    expect(result.blockedDomains).toEqual([]);
  });

  it('returns non-zero exit code when agent fails', async () => {
    makeAgentExecaMock('1');
    const result = await runAgentCommand(WORK_DIR, []);
    expect(result.exitCode).toBe(1);
  });

  it('warns about blocked domains when exit code non-zero and denials exist', async () => {
    makeAgentExecaMock('1');
    mockCheckSquidLogs.mockResolvedValue({
      hasDenials: true,
      blockedTargets: [{ target: 'evil.com', domain: 'evil.com' }],
    });

    const result = await runAgentCommand(WORK_DIR, ['github.com']);
    expect(result.exitCode).toBe(1);
    expect(result.blockedDomains).toEqual(['evil.com']);
  });

  it('returns exit code 143 when agent was externally killed', async () => {
    makeAgentExecaMock('0');
    mockIsAgentExternallyKilled.mockReturnValue(true);

    const result = await runAgentCommand(WORK_DIR, []);
    expect(result.exitCode).toBe(143);
    expect(result.blockedDomains).toEqual([]);
  });

  it('returns exit code 124 on timeout', async () => {
    let resolveWait!: () => void;
    const waitPromise = new Promise<void>(r => { resolveWait = r; });

    mockExecaFn.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('-f')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      if (Array.isArray(args) && args.includes('wait')) {
        return waitPromise.then(() => ({ stdout: '0', stderr: '', exitCode: 0 }));
      }
      if (Array.isArray(args) && args.includes('stop')) {
        resolveWait();
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    });

    jest.useFakeTimers();
    const resultPromise = runAgentCommand(WORK_DIR, [], undefined, 0.001);
    await jest.runAllTimersAsync();
    const result = await resultPromise;
    jest.useRealTimers();

    expect(result.exitCode).toBe(124);
  });

  it('throws when docker wait command fails', async () => {
    mockExecaFn.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('-f')) {
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }
      return Promise.reject(new Error('docker wait failed'));
    });

    await expect(runAgentCommand(WORK_DIR, [])).rejects.toThrow('docker wait failed');
  });

  it('does not warn about blocked domains when exit code is 0', async () => {
    makeAgentExecaMock('0');
    mockCheckSquidLogs.mockResolvedValue({
      hasDenials: true,
      blockedTargets: [{ target: 'evil.com', domain: 'evil.com' }],
    });

    const { logger } = await import('./logger');
    const result = await runAgentCommand(WORK_DIR, []);
    expect(result.exitCode).toBe(0);
    expect(logger.warn).not.toHaveBeenCalledWith('Firewall blocked domains:');
  });
});

// ─── fastKillAgentContainer ───────────────────────────────────────────────────

describe('fastKillAgentContainer', () => {
  it('marks agent as externally killed and stops the container', async () => {
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await fastKillAgentContainer();
    expect(mockMarkAgentExternallyKilled).toHaveBeenCalled();
    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['stop', '-t', '3']),
      expect.any(Object),
    );
  });

  it('uses custom stop timeout', async () => {
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await fastKillAgentContainer(10);
    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['stop', '-t', '10']),
      expect.any(Object),
    );
  });

  it('does not throw when docker stop fails', async () => {
    mockExecaFn.mockRejectedValue(new Error('docker not available'));
    await expect(fastKillAgentContainer()).resolves.toBeUndefined();
  });
});
