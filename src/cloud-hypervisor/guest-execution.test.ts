import type { MicrovmVsockClient } from '../microvm/vsock-client';
import { CloudHypervisorGuestChannel, connectGuestWithRetry } from './guest-execution';
import type { CloudHypervisorManagerDependencies } from './manager-types';

function vsockClientMock(overrides: Partial<MicrovmVsockClient> = {}): MicrovmVsockClient {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue({ exitCode: 0 }),
    cancel: jest.fn().mockResolvedValue(undefined),
    writeStdin: jest.fn().mockResolvedValue(undefined),
    endStdin: jest.fn().mockResolvedValue(undefined),
    resize: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(),
    ...overrides,
  } as unknown as MicrovmVsockClient;
}

function dependencies(
  createVsockClient: CloudHypervisorManagerDependencies['createVsockClient'],
): CloudHypervisorManagerDependencies {
  return {
    createVsockClient,
    sleep: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudHypervisorManagerDependencies;
}

describe('connectGuestWithRetry', () => {
  it('retries with a fresh client until the guest supervisor is listening', async () => {
    const failing = vsockClientMock({
      connect: jest.fn().mockRejectedValue(new Error('guest disconnected before readiness')),
    });
    const ready = vsockClientMock();
    const createVsockClient = jest.fn()
      .mockReturnValueOnce(failing)
      .mockReturnValueOnce(ready);
    const deps = dependencies(createVsockClient);

    await expect(connectGuestWithRetry(deps, '/run/vsock.socket', 52, 10)).resolves.toBe(ready);
    expect(createVsockClient).toHaveBeenCalledTimes(2);
    expect(failing.destroy).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalled();
  });
});

describe('CloudHypervisorGuestChannel', () => {
  it('forwards execution and IO calls to the connected vsock client', async () => {
    const client = vsockClientMock();
    const channel = new CloudHypervisorGuestChannel(client);

    await channel.execute({ command: ['true'] } as never);
    await channel.cancel('host cancellation', 'req-1');
    await channel.writeStdin(Buffer.from('hi'), 'req-1');
    await channel.endStdin('req-1');
    await channel.resize(80, 24, 'req-1');

    expect(client.execute).toHaveBeenCalledWith({ command: ['true'] });
    expect(client.cancel).toHaveBeenCalledWith('host cancellation', 'req-1');
    expect(client.writeStdin).toHaveBeenCalledWith(Buffer.from('hi'), 'req-1');
    expect(client.endStdin).toHaveBeenCalledWith('req-1');
    expect(client.resize).toHaveBeenCalledWith(80, 24, 'req-1');
  });

  it('reports an acknowledged shutdown', async () => {
    const client = vsockClientMock();

    await expect(new CloudHypervisorGuestChannel(client).shutdown())
      .resolves.toEqual({ acknowledged: true });
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('treats a busy guest refusal as a non-error unacknowledged shutdown', async () => {
    const client = vsockClientMock({
      shutdown: jest.fn().mockRejectedValue(
        new Error('Cannot shut down guest while a request is running'),
      ),
    });

    await expect(new CloudHypervisorGuestChannel(client).shutdown())
      .resolves.toEqual({ acknowledged: false });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns any other shutdown failure for caller aggregation', async () => {
    const failure = new Error('vsock write failed');
    const client = vsockClientMock({ shutdown: jest.fn().mockRejectedValue(failure) });

    await expect(new CloudHypervisorGuestChannel(client).shutdown())
      .resolves.toEqual({ acknowledged: false, error: failure });
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
