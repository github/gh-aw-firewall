import type { ExecaChildProcess } from 'execa';
import { waitForApiSocket } from './diagnostics-readiness';
import { createCloudHypervisorRunPaths } from './manager-types';
import { dependencies } from './manager.test-utils';

describe('Cloud Hypervisor API socket readiness', () => {
  const paths = createCloudHypervisorRunPaths('/opt/cloud-hypervisor', 'readiness');
  const missing = Object.assign(new Error('missing socket'), { code: 'ENOENT' });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries missing sockets until the API is ready', async () => {
    const deps = dependencies({
      access: jest.fn().mockRejectedValueOnce(missing).mockResolvedValue(undefined),
      sleep: jest.fn(async (milliseconds) => { jest.advanceTimersByTime(milliseconds); }),
    });
    await waitForApiSocket(deps, paths, 50, undefined);
    expect(deps.access).toHaveBeenCalledTimes(2);
    expect(deps.access).toHaveBeenCalledWith(paths.apiSocketPath);
    expect(deps.sleep).toHaveBeenCalledWith(25);
  });

  it('stops retrying at the configured deadline', async () => {
    const deps = dependencies({
      access: jest.fn().mockRejectedValue(missing),
      sleep: jest.fn(async (milliseconds) => { jest.advanceTimersByTime(milliseconds); }),
    });
    await expect(waitForApiSocket(deps, paths, 50, undefined))
      .rejects.toThrow(`Cloud Hypervisor API socket was not ready after 50ms: ${paths.apiSocketPath}`);
    expect(deps.access).toHaveBeenCalledTimes(2);
  });

  it('propagates socket access failures other than ENOENT', async () => {
    const error = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const deps = dependencies({ access: jest.fn().mockRejectedValue(error) });
    await expect(waitForApiSocket(deps, paths, 50, undefined)).rejects.toBe(error);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it.each([
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' },
  ])('rejects an exited launcher (%j) before checking the socket', async (state) => {
    const deps = dependencies();
    await expect(waitForApiSocket(deps, paths, 50, state as ExecaChildProcess<string>))
      .rejects.toThrow('Cloud Hypervisor exited before API readiness');
    expect(deps.access).not.toHaveBeenCalled();
  });
});
