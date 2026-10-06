import { createCloudHypervisorHostEnclaveExecutor } from '../cloud-hypervisor/host-enclave-executor';
import { startHostExecutorServer } from './host-executor-server';
import {
  startCloudHypervisorEnclaveHostService,
  type CloudHypervisorEnclaveHostServiceOptions,
} from './cloud-hypervisor-host-service';

jest.mock('../cloud-hypervisor/host-enclave-executor');
jest.mock('./host-executor-server');

describe('Cloud Hypervisor enclave host service composition', () => {
  const options: CloudHypervisorEnclaveHostServiceOptions = {
    runtimeDir: '/awf/private/host-executor',
    workDir: '/awf/private',
    config: {} as CloudHypervisorEnclaveHostServiceOptions['config'],
    runState: {
      runId: 'a'.repeat(32),
      seedsDir: '/awf/private/seeds',
      invocationsDir: '/awf/private/invocations',
      entries: [],
    },
  };
  const createBackend = jest.mocked(createCloudHypervisorHostEnclaveExecutor);
  const startServer = jest.mocked(startHostExecutorServer);

  beforeEach(() => jest.resetAllMocks());

  it('does not expose a listener if trusted host or artifact preflight fails', async () => {
    createBackend.mockRejectedValue(new Error('preflight failed'));
    await expect(startCloudHypervisorEnclaveHostService(options)).rejects.toThrow('preflight failed');
    expect(startServer).not.toHaveBeenCalled();
  });

  it('binds the authenticated listener to the preflighted backend and trusted run', async () => {
    const backend = { execute: jest.fn(), close: jest.fn() };
    createBackend.mockResolvedValue(backend as never);
    const server = { socketPath: '/private/executor.sock' };
    startServer.mockResolvedValue(server as never);
    await expect(startCloudHypervisorEnclaveHostService(options)).resolves.toBe(server);
    expect(createBackend).toHaveBeenCalledWith(options);
    expect(startServer).toHaveBeenCalledWith({
      runtimeDir: options.runtimeDir,
      runState: options.runState,
      backend,
    });
  });

  it('releases verified artifacts on listener failure without disclosing backend details', async () => {
    const backend = { execute: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
    createBackend.mockResolvedValue(backend as never);
    startServer.mockRejectedValue(new Error('private launch details'));
    const onPreflightStage = jest.fn();
    await expect(startCloudHypervisorEnclaveHostService({ ...options, onPreflightStage }))
      .rejects.toThrow('Cloud Hypervisor enclave host service could not start');
    expect(onPreflightStage).toHaveBeenCalledWith('host-service');
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('keeps cleanup failures redacted and never returns a partially started service', async () => {
    const backend = { execute: jest.fn(), close: jest.fn().mockRejectedValue(new Error('private cleanup details')) };
    createBackend.mockResolvedValue(backend as never);
    startServer.mockRejectedValue(new Error('private launch details'));
    await expect(startCloudHypervisorEnclaveHostService(options))
      .rejects.toThrow('Cloud Hypervisor enclave host service could not start');
    expect(backend.close).toHaveBeenCalledTimes(1);
  });
});
