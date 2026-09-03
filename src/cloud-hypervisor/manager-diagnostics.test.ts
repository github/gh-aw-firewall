import { PassThrough } from 'stream';
import { CloudHypervisorManager } from './manager';

import {
  config, processMock, networkConfig, networkLifecycle, dependencies,
} from './manager.test-utils';

  describe('diagnostics collection', () => {
  it('collects bounded diagnostics including VM counters', async () => {
    const oversized = Buffer.alloc(1024 * 1024 + 128, 0x61);
    const child = processMock();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      readFileTail: jest.fn().mockImplementation((_source: string, maxBytes: number) =>
        Promise.resolve(oversized.subarray(oversized.length - maxBytes)),
      ),
    });
    const manager = new CloudHypervisorManager(
      config(),
      '/tmp/awf',
      deps,
      'diagnostics',
      networkConfig(),
    );

    const client = await manager.start();
    stdout.write(oversized);
    stderr.write('launcher error');
    await manager.startInstance();
    await manager.collectDiagnostics('/tmp/diagnostics');

    expect(client.vmCounters).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/launcher-stdout.log',
      expect.objectContaining({ length: 1024 * 1024 }),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/launcher-stderr.log',
      Buffer.from('launcher error'),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/counters.json',
      expect.stringContaining('rx_bytes'),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/confinement.json',
      expect.stringContaining('"schemaVersion": 1'),
      { mode: 0o600 },
    );
  });

  it('snapshots vm.info/vm.counters before any shutdown attempt, so collectDiagnostics() via beforeCleanup still has real data', async () => {
    // Regression test: vm.info/vm.counters require the Cloud Hypervisor
    // API socket to still be responsive. collectDiagnostics() usually
    // runs via stop()'s beforeCleanup hook -- deliberately placed *after*
    // process termination is confirmed (see that hook's own comment) so
    // buffered serial console output has been flushed. But by that point
    // the API socket is already closed (the process was just asked to
    // exit), so a live vmCounters()/vmInfo() call there would always
    // fail. stop() must snapshot both *before* it calls vmmShutdown(),
    // and collectDiagnostics() must prefer that snapshot over a live call
    // that can no longer succeed.
    const child = processMock();
    const deps = dependencies({ launch: jest.fn().mockReturnValue(child) });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'vm-info-snapshot', networkConfig(),
    );
    const client = await manager.start();
    await manager.startInstance();

    let diagnosticsRanWithLiveClient = false;
    await manager.stop({
      beforeCleanup: async () => {
        // Simulate collectDiagnostics() running here, as it does via the
        // real beforeCleanup wiring in cloud-hypervisor-runtime-backend.ts.
        await manager.collectDiagnostics('/tmp/diagnostics');
        diagnosticsRanWithLiveClient = true;
      },
    });

    expect(diagnosticsRanWithLiveClient).toBe(true);
    // vmCounters/vmInfo were called exactly once each: during stop()'s
    // pre-shutdown snapshot, not again (uselessly) from inside
    // collectDiagnostics() after the client reference is already cleared.
    expect(client.vmCounters).toHaveBeenCalledTimes(1);
    expect(client.vmInfo).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/counters.json',
      expect.stringContaining('rx_bytes'),
      { mode: 0o600 },
    );
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/vm-info.json',
      expect.not.stringMatching(/^null$/m),
      { mode: 0o600 },
    );
  });

  it('captures live network diagnostics (nft ruleset + interface counters) when the network lifecycle supports it', async () => {
    // Regression test: a live-KVM connectivity failure investigation found
    // that a bare probe exit code, and even the static network-plan.json,
    // weren't enough to determine whether packets were being dropped by
    // an nftables forward-chain rule or never reaching the tap at all.
    // collectDiagnostics() must capture this live state (via the
    // network lifecycle's optional captureDiagnostics()) while the
    // namespace still exists.
    const child = processMock();
    const captureDiagnostics = jest.fn()
      .mockResolvedValue('--- nft list ruleset ---\n(fake ruleset)\n');
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createNetwork: jest.fn((plan) => ({
        ...networkLifecycle(plan),
        captureDiagnostics,
      })),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'net-diagnostics', networkConfig(),
    );

    await manager.start();
    await manager.collectDiagnostics('/tmp/diagnostics');

    expect(captureDiagnostics).toHaveBeenCalledTimes(1);
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/network-diagnostics.txt',
      '--- nft list ruleset ---\n(fake ruleset)\n\n',
      { mode: 0o600 },
    );
  });

  it('reports network diagnostics as unavailable when the lifecycle does not support capture, without throwing', async () => {
    const child = processMock();
    const deps = dependencies({ launch: jest.fn().mockReturnValue(child) });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'net-diagnostics-unset', networkConfig(),
    );

    await manager.start();
    await expect(manager.collectDiagnostics('/tmp/diagnostics')).resolves.toBeUndefined();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/network-diagnostics.txt',
      expect.stringContaining('network namespace not set up'),
      { mode: 0o600 },
    );
  });

  it('falls back to a capture-failed message rather than throwing when captureDiagnostics itself rejects', async () => {
    const child = processMock();
    const deps = dependencies({
      launch: jest.fn().mockReturnValue(child),
      createNetwork: jest.fn((plan) => ({
        ...networkLifecycle(plan),
        captureDiagnostics: jest.fn().mockRejectedValue(new Error('ip netns exec failed')),
      })),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'net-diagnostics-fail', networkConfig(),
    );

    await manager.start();
    await expect(manager.collectDiagnostics('/tmp/diagnostics')).resolves.toBeUndefined();

    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/diagnostics/network-diagnostics.txt',
      expect.stringContaining('capture failed: ip netns exec failed'),
      { mode: 0o600 },
    );
  });
});
