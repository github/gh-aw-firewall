import { logger } from '../logger';
import { runVersionWithRetry } from './preflight-version-probe';

describe('isolated preflight version probe retries', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries transient failures with the bounded delay and stops on success', async () => {
    const runVersion = jest.fn()
      .mockRejectedValueOnce(new Error('transient I/O error'))
      .mockResolvedValue('cloud-hypervisor v53.0');
    const result = runVersionWithRetry({ runVersion }, '/snapshot/cloud-hypervisor');
    const assertion = expect(result).resolves.toBe('cloud-hypervisor v53.0');
    await jest.advanceTimersByTimeAsync(249);
    expect(runVersion).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(runVersion.mock.calls).toEqual([
      ['/snapshot/cloud-hypervisor'], ['/snapshot/cloud-hypervisor'],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with the last failure after exactly three attempts', async () => {
    const failure = new Error('persistent I/O error');
    const runVersion = jest.fn().mockRejectedValue(failure);
    const result = runVersionWithRetry({ runVersion }, '/snapshot/cloud-hypervisor');
    const assertion = expect(result).rejects.toBe(failure);
    await jest.runAllTimersAsync();
    await assertion;
    expect(runVersion).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'ENOEXEC'])(
    'does not retry structured or message-only %s failures',
    async (code) => {
      for (const failure of [
        Object.assign(new Error('spawn failed'), { code }),
        new Error(`spawn failed: code=${code}`),
      ]) {
        const runVersion = jest.fn().mockRejectedValue(failure);
        await expect(runVersionWithRetry({ runVersion }, '/snapshot/cloud-hypervisor'))
          .rejects.toBe(failure);
        expect(runVersion).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      }
    },
  );
});
