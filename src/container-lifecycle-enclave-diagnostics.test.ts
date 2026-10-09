import * as fs from 'fs';
import * as path from 'path';
import { startContainers } from './container-lifecycle';
import { runComposeDown } from './container-stop';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';
import { didContainerFailStartup, handleHealthcheckError, logContainerLogsToStderr } from './container-startup-diagnostics';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('./container-startup-diagnostics');

describe('enclave diagnostics before Compose retry and removal', () => {
  const { getDir } = useTempDir();
  let attempts: number;
  let removed: number;

  function records() {
    const directory = path.join(getDir(), 'logs', 'enclave-startup');
    return fs.existsSync(directory) ? fs.readdirSync(directory).map(name =>
      JSON.parse(fs.readFileSync(path.join(directory, name, 'diagnostic.json'), 'utf8'))) : [];
  }

  beforeEach(() => {
    attempts = 0;
    removed = 0;
    mockExecaFn.mockReset();
    jest.mocked(didContainerFailStartup).mockReset();
    jest.mocked(handleHealthcheckError).mockRejectedValue(new Error('startup failed'));
    jest.mocked(logContainerLogsToStderr).mockResolvedValue(undefined);
    mockExecaFn.mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'compose config --services') {
        return { exitCode: 0, stdout: 'squid-proxy\napi-proxy\nenclave-mcp-server\nagent\n', stderr: '' };
      }
      if (args[0] === 'compose' && args[1] === 'up') attempts++;
      if (args[0] === 'compose' && args[1] === 'down') {
        expect(records().length).toBeGreaterThanOrEqual(removed + 1);
        removed++;
      }
      if (args[0] === 'inspect') {
        return { exitCode: 0, stdout: '{"status":"exited","exitCode":1,"running":false,"oomKilled":false,"hasError":false}', stderr: '' };
      }
      if (args[0] === 'logs') {
        return { exitCode: 0, stdout: '', stderr: 'Error: ENOENT secret repository seed' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  });

  it('captures failed attachment before the next invocation removes conflicting containers', async () => {
    jest.mocked(didContainerFailStartup).mockResolvedValue(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(startContainers(getDir(), [], path.join(getDir(), 'logs'), true, undefined,
        async () => { throw new Error('gateway attachment failed'); }))
        .rejects.toThrow('gateway attachment failed');
      expect(records()).toHaveLength(attempt + 1);
    }
    await runComposeDown(getDir());
    expect(records()).toHaveLength(2);
    expect(records()[0]).toMatchObject({ state: { exitCode: 1 }, logs: { code: 'ENOENT' } });
    expect(JSON.stringify(records())).not.toContain('secret');
    expect(attempts).toBe(2);
    expect(logContainerLogsToStderr).not.toHaveBeenCalled();
  });

  it('captures infrastructure failure before the internal automatic retry teardown', async () => {
    const regularCommands = mockExecaFn.getMockImplementation()!;
    mockExecaFn.mockImplementation(async (command, args, options) => {
      if (args[0] === 'compose' && args[1] === 'up' && attempts === 0) {
        attempts++;
        throw new Error('api-proxy failed during first infrastructure start');
      }
      return regularCommands(command, args, options);
    });
    jest.mocked(didContainerFailStartup).mockImplementation(async (_error, container) =>
      container === 'awf-api-proxy' && attempts === 1);
    await expect(startContainers(getDir(), [], path.join(getDir(), 'logs'), true, undefined,
      async () => { throw new Error('gateway readiness failed on retry'); }))
      .rejects.toThrow();
    expect(attempts).toBe(2);
    expect(removed).toBe(1);
    expect(records()).toHaveLength(2);
    await runComposeDown(getDir());
    expect(records()).toHaveLength(2);
  });

  it('does not collect diagnostics when infrastructure and readiness succeed', async () => {
    await startContainers(getDir(), [], undefined, true, undefined, async () => undefined);
    expect(mockExecaFn.mock.calls.some(([, args]) => args[0] === 'logs')).toBe(false);
    expect(fs.existsSync(path.join(getDir(), 'squid-logs', 'enclave-startup'))).toBe(false);
  });

  it('does not collect enclave evidence for a non-enclave readiness gate', async () => {
    const regularCommands = mockExecaFn.getMockImplementation()!;
    mockExecaFn.mockImplementation(async (command, args, options) =>
      args.join(' ') === 'compose config --services'
        ? { exitCode: 0, stdout: 'squid-proxy\nagent\n', stderr: '' }
        : regularCommands(command, args, options));
    await expect(startContainers(getDir(), [], undefined, true, undefined,
      async () => { throw new Error('unrelated readiness failure'); })).rejects.toThrow();
    expect(mockExecaFn.mock.calls.some(([, args]) => args[0] === 'logs')).toBe(false);
  });
});
