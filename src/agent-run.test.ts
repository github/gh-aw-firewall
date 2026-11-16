// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./squid-block-report', () => ({
  reportSquidBlocks: jest.fn().mockResolvedValue([]),
}));

import { runAgentCommand } from './agent-run';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';
import { markAgentExternallyKilled } from './container-lifecycle-state';
import { logger } from './logger';
import { reportSquidBlocks } from './squid-block-report';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const workDir = '/tmp/awf-agent-run-test';

describe('agent execution module', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockExecaFn.mockReset();
    jest.mocked(reportSquidBlocks).mockClear();
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shares the host deadline across gVisor startup retries', async () => {
    const startedAt = new Date().toISOString();
    const finishedAt = new Date(Date.now() + 20_000).toISOString();
    mockExecaFn
      .mockResolvedValueOnce(ok()) // logs, first attempt
      .mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve(ok('139')), 20_000);
      }))
      .mockResolvedValueOnce(ok(`${startedAt} ${finishedAt}`))
      .mockResolvedValueOnce(ok()) // restart
      .mockResolvedValueOnce(ok()) // logs, second attempt
      .mockReturnValueOnce(new Promise<never>(() => {})) // wait, second attempt
      .mockResolvedValueOnce(ok()); // timeout stop

    const result = runAgentCommand(workDir, ['github.com'], undefined, 1, 'gvisor');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockExecaFn.mock.calls.map(([, args]) => args[0]))
      .toEqual(['logs', 'wait', 'inspect', 'start', 'logs', 'wait']);

    await jest.advanceTimersByTimeAsync(39_999);
    expect(mockExecaFn).not.toHaveBeenCalledWith(
      'docker', ['stop', '-t', '10', 'awf-agent'], expect.anything(),
    );

    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ exitCode: 124, blockedDomains: [] });
    expect(mockExecaFn).toHaveBeenLastCalledWith(
      'docker', ['stop', '-t', '10', 'awf-agent'], expect.objectContaining({ reject: false }),
    );
    expect(reportSquidBlocks).toHaveBeenCalledWith(workDir, ['github.com'], 124, undefined);
  });

  it('stops without another docker wait if restarting exhausts the deadline', async () => {
    const timestamp = new Date().toISOString();
    mockExecaFn
      .mockResolvedValueOnce(ok()) // logs, first attempt
      .mockResolvedValueOnce(ok('134'))
      .mockResolvedValueOnce(ok(`${timestamp} ${timestamp}`))
      .mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve(ok()), 60_000);
      }))
      .mockResolvedValueOnce(ok()) // logs, second attempt
      .mockResolvedValueOnce(ok()); // timeout stop

    const result = runAgentCommand(workDir, [], undefined, 1, 'gvisor');
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual({ exitCode: 124, blockedDomains: [] });
    expect(mockExecaFn.mock.calls.map(([, args]) => args[0]))
      .toEqual(['logs', 'wait', 'inspect', 'start', 'logs', 'stop']);
  });

  it('does not enter Squid reporting when the agent was externally killed', async () => {
    markAgentExternallyKilled();
    mockExecaFn
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('0'));

    await expect(runAgentCommand(workDir, []))
      .resolves.toEqual({ exitCode: 143, blockedDomains: [] });
    expect(reportSquidBlocks).not.toHaveBeenCalled();
  });
});
