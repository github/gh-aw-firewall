import type { WorkflowDependencies } from './cli-workflow';
import {
  adaptExternalRuntimeBackend,
  type ExternalAgentRuntimeBackend,
} from './external-runtime-backend';
import { resolveExternalRuntimeBackend } from './external-runtime-backend-resolver';
import type { WrapperConfig } from './types';

function createBackend(): jest.Mocked<ExternalAgentRuntimeBackend> {
  return {
    runtime: 'test-runtime',
    preflight: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockResolvedValue({ exitCode: 17 }),
    collectDiagnostics: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  };
}

describe('external runtime backend', () => {
  const startInfrastructure = jest.fn() as jest.MockedFunction<
    WorkflowDependencies['startContainers']
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('leaves compose runtimes on the existing workflow path', () => {
    const factory = jest.fn();
    const backend = resolveExternalRuntimeBackend(
      { containerRuntime: 'gvisor' } as WrapperConfig,
      startInfrastructure,
      { gvisor: factory },
    );

    expect(backend).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it('resolves a registered external runtime with compose infrastructure', () => {
    const backend = createBackend();
    const factory = jest.fn().mockReturnValue(backend);
    const config = { containerRuntime: 'sbx' } as WrapperConfig;

    expect(resolveExternalRuntimeBackend(
      config,
      startInfrastructure,
      { sbx: factory },
    )).toBe(backend);
    expect(factory).toHaveBeenCalledWith({ config, startInfrastructure });
  });

  it('fails explicitly when a microVM runtime has no backend', () => {
    expect(() => resolveExternalRuntimeBackend(
      { containerRuntime: 'sbx' } as WrapperConfig,
      startInfrastructure,
      {},
    )).toThrow('No external agent runtime backend is registered for "sbx"');
  });

  it('requires explicit Firecracker preview opt-in during resolution', () => {
    const config = {
      containerRuntime: 'firecracker',
      firecracker: { previewEnabled: false },
    } as WrapperConfig;
    expect(() => resolveExternalRuntimeBackend(config, startInfrastructure))
      .toThrow(/explicit --firecracker-preview/);
    expect(startInfrastructure).not.toHaveBeenCalled();
  });

  it('uses the registered Firecracker factory after preview opt-in', () => {
    const backend = resolveExternalRuntimeBackend({
      containerRuntime: 'firecracker',
      firecracker: { previewEnabled: true },
    } as WrapperConfig, startInfrastructure);

    expect(backend?.runtime).toBe('firecracker');
  });

  it('requires explicit Cloud Hypervisor preview opt-in during resolution', () => {
    const config = {
      containerRuntime: 'cloud-hypervisor',
      cloudHypervisor: { previewEnabled: false },
    } as WrapperConfig;
    expect(() => resolveExternalRuntimeBackend(config, startInfrastructure))
      .toThrow(/explicit --cloud-hypervisor-preview/);
    expect(startInfrastructure).not.toHaveBeenCalled();
  });

  it('uses the registered Cloud Hypervisor factory after preview opt-in', () => {
    const backend = resolveExternalRuntimeBackend({
      containerRuntime: 'cloud-hypervisor',
      cloudHypervisor: { previewEnabled: true },
    } as WrapperConfig, startInfrastructure);

    expect(backend?.runtime).toBe('cloud-hypervisor');
  });
  it('adapts start and exec without changing arguments or exit codes', async () => {
    const backend = createBackend();
    const adapted = adaptExternalRuntimeBackend(backend);
    const onNetworkReady = jest.fn();
    const onInfrastructureReady = jest.fn();

    await adapted.startContainers(
      '/tmp/awf',
      ['github.com'],
      '/tmp/logs',
      true,
      onNetworkReady,
      onInfrastructureReady,
    );
    await expect(adapted.runAgentCommand(
      '/tmp/awf',
      ['github.com'],
      '/tmp/logs',
      9,
    )).resolves.toEqual({ exitCode: 17 });

    expect(backend.start).toHaveBeenCalledWith(
      '/tmp/awf',
      ['github.com'],
      '/tmp/logs',
      true,
      onNetworkReady,
      onInfrastructureReady,
    );
    expect(backend.exec).toHaveBeenCalledWith(
      '/tmp/awf',
      ['github.com'],
      '/tmp/logs',
      9,
    );
  });
});
