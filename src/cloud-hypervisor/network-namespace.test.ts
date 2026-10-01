import { LinuxNetworkCommands } from '../microvm/network';
import {
  CloudHypervisorEmptyNetworkNamespace,
  createCloudHypervisorEmptyNetworkNamespacePlan,
} from './network-namespace';

function commands() {
  return {
    ip: jest.fn().mockResolvedValue(undefined),
    captureDiagnosticsInNamespace: jest.fn().mockResolvedValue('namespace diagnostics'),
  } as unknown as LinuxNetworkCommands;
}

describe('CloudHypervisorEmptyNetworkNamespace', () => {
  it('creates only an empty network namespace and deletes it idempotently', async () => {
    const networkCommands = commands();
    const observer = { resourceCreated: jest.fn().mockResolvedValue(undefined) };
    const plan = createCloudHypervisorEmptyNetworkNamespacePlan('script-run');
    const lifecycle = new CloudHypervisorEmptyNetworkNamespace(
      plan,
      networkCommands,
      observer,
    );

    await lifecycle.setup();
    expect(networkCommands.ip).toHaveBeenCalledTimes(1);
    expect(networkCommands.ip).toHaveBeenCalledWith(['netns', 'add', plan.namespaceName]);
    expect(observer.resourceCreated).toHaveBeenCalledWith('netns');
    await expect(lifecycle.captureDiagnostics()).resolves.toBe('namespace diagnostics');

    await lifecycle.cleanup();
    await lifecycle.cleanup();
    expect(networkCommands.ip).toHaveBeenCalledTimes(2);
    expect(networkCommands.ip).toHaveBeenLastCalledWith(['netns', 'delete', plan.namespaceName]);
  });

  it('rolls back the namespace when durable identity capture fails', async () => {
    const networkCommands = commands();
    const lifecycle = new CloudHypervisorEmptyNetworkNamespace(
      createCloudHypervisorEmptyNetworkNamespacePlan('capture-failure'),
      networkCommands,
      { resourceCreated: jest.fn().mockRejectedValue(new Error('capture failed')) },
    );

    await expect(lifecycle.setup()).rejects.toThrow('capture failed');
    expect((networkCommands.ip as jest.Mock).mock.calls).toEqual([
      [['netns', 'add', lifecycle.plan.namespaceName]],
      [['netns', 'delete', lifecycle.plan.namespaceName]],
    ]);
  });

  it('derives a closed run-scoped namespace plan and rejects unsafe run IDs', () => {
    expect(createCloudHypervisorEmptyNetworkNamespacePlan('script-run')).toEqual({
      mode: 'none',
      namespaceName: expect.stringMatching(/^awfvm-[0-9a-f]{12}$/),
      netnsPath: expect.stringMatching(/^\/var\/run\/netns\/awfvm-[0-9a-f]{12}$/),
    });
    expect(() => createCloudHypervisorEmptyNetworkNamespacePlan('../escape')).toThrow(
      /Unsafe microVM run id/,
    );
  });
});
