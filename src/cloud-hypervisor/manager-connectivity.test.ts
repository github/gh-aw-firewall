import type { MicrovmVsockClient } from '../microvm/vsock-client';
import { CloudHypervisorManager } from './manager';

import {
  rootfsPreparerMock, config, processMock, networkConfig, guestConfig, dependencies,
} from './manager.test-helpers';

  describe('guest connectivity', () => {
  it('retries the vsock connect on the guest-not-ready-yet boot race, with a fresh client each attempt', async () => {
    // Regression test: Cloud Hypervisor's vsock-over-UDS multiplexer closes
    // the host-facing connection immediately if the guest isn't yet
    // listening on the target port, surfacing as "guest disconnected
    // before readiness" even though vm.boot() itself succeeded — a real
    // host/guest boot-timing race, not a fatal error. startInstance() must
    // retry with a fresh client (MicrovmVsockClient cannot reconnect a
    // socket that already closed) until the guest is ready.
    const readyFrame = {
      version: 1,
      type: 'ready' as const,
      requestId: 'control',
      capabilities: { stdin: true, tty: false, resize: false },
    };
    const failingClient = {
      connect: jest.fn().mockRejectedValue(new Error('guest disconnected before readiness')),
      destroy: jest.fn(),
    };
    const succeedingClient = {
      connect: jest.fn().mockResolvedValue(readyFrame),
      execute: jest.fn().mockResolvedValue({
        requestId: 'command', exitCode: 0, signal: null, timedOut: false,
      }),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    };
    const createVsockClient = jest.fn()
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(succeedingClient);
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(processMock()),
      createRootfsPreparer: jest.fn().mockReturnValue(rootfsPreparerMock()),
      createVsockClient,
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'retry-guest',
      networkConfig(),
      guestConfig(),
    );

    await manager.start();
    await manager.startInstance();

    expect(createVsockClient).toHaveBeenCalledTimes(3);
    expect(failingClient.destroy).toHaveBeenCalledTimes(2);
    expect(succeedingClient.connect).toHaveBeenCalledTimes(1);
  });

  it('tolerates guest boot taking well beyond the old 20-second budget under slow (nested-virtualization) conditions', async () => {
    // Regression test: live-KVM validation on GitHub-hosted runners showed
    // guest boot legitimately taking far longer than 20 seconds of real
    // wall-clock time under nested virtualization (severe vCPU scheduling
    // contention advanced the guest's own boot-log clock far slower than
    // host wall-clock time). The vsock connect-retry budget was increased
    // from 20s to 90s so a merely-slow (not hung/crashed) guest isn't
    // aborted early. Simulate ~21s of wall-clock time elapsing per failed
    // connect attempt and assert the retry loop survives several such
    // cycles — which the old 20s budget could not have tolerated even
    // once — before finally giving up once the 90s budget is exhausted.
    const startedAtMs = 1_000_000;
    let elapsedMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => startedAtMs + elapsedMs);
    const failingClient = {
      connect: jest.fn().mockImplementation(() => {
        elapsedMs += 21_000;
        return Promise.reject(new Error('guest disconnected before readiness'));
      }),
      destroy: jest.fn(),
    };
    const createVsockClient = jest.fn().mockReturnValue(failingClient);
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(processMock()),
      createRootfsPreparer: jest.fn().mockReturnValue(rootfsPreparerMock()),
      createVsockClient,
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'retry-guest-slow-boot',
      networkConfig(),
      guestConfig(),
    );

    try {
      await manager.start();
      await expect(manager.startInstance()).rejects.toThrow(
        'guest disconnected before readiness',
      );

      // A 20s budget would have given up after a single ~21s attempt; the
      // 90s budget must retry at least four times (~84s simulated) before
      // exhausting.
      expect(createVsockClient.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  it('delegates guest cancellation, stdin, and resize only after readiness', async () => {
    const cold = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      dependencies(),
      'cold-guest',
      networkConfig(),
    );
    await expect(cold.cancel()).rejects.toThrow(/supervisor is not ready/);
    await expect(cold.writeStdin(Buffer.from('input'))).rejects.toThrow(/supervisor is not ready/);
    await expect(cold.endStdin()).rejects.toThrow(/supervisor is not ready/);
    await expect(cold.resize(80, 24)).rejects.toThrow(/supervisor is not ready/);

    const guestClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
      writeStdin: jest.fn().mockResolvedValue(undefined),
      endStdin: jest.fn().mockResolvedValue(undefined),
      resize: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn(),
    } as unknown as MicrovmVsockClient;
    const deps = dependencies({
      createVsockClient: jest.fn().mockReturnValue(guestClient),
    });
    const manager = new CloudHypervisorManager(
      config({ apiTimeoutMs: 1_000 }),
      '/tmp/awf',
      deps,
      'ready-guest',
      networkConfig(),
      guestConfig(),
    );
    await manager.start();
    await manager.startInstance();
    await manager.cancel('test', 'request');
    await manager.writeStdin(Buffer.from('input'), 'request');
    await manager.endStdin('request');
    await manager.resize(80, 24, 'request');

    expect(guestClient.cancel).toHaveBeenCalledWith('test', 'request');
    expect(guestClient.writeStdin).toHaveBeenCalledWith(Buffer.from('input'), 'request');
    expect(guestClient.endStdin).toHaveBeenCalledWith('request');
    expect(guestClient.resize).toHaveBeenCalledWith(80, 24, 'request');
    await manager.stop();
  });
  });

