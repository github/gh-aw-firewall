import {
  assertAgentRuntimeAvailable,
  assertPrimaryRuntimeAvailable,
  assertScriptRuntimeAvailable,
  resolvePrimaryRuntimeBackend,
} from './runtime-preflight';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
} from '../types/enclave-options';
import type { WrapperConfig } from '../types';

const dockerAvailable = jest.fn<Promise<boolean>, []>();
const runtimeAvailable = jest.fn<Promise<boolean>, [string]>();
const sbxAvailable = jest.fn<Promise<boolean>, []>();

beforeEach(() => {
  dockerAvailable.mockReset().mockResolvedValue(true);
  runtimeAvailable.mockReset().mockResolvedValue(true);
  sbxAvailable.mockReset().mockResolvedValue(true);
});

describe('enclave runtime preflight', () => {
  it.each([
    [undefined, 'docker'],
    ['docker', 'docker'],
    ['gvisor', 'gvisor'],
    ['runsc', 'gvisor'],
    ['sbx', 'sbx'],
    ['cloud-hypervisor', 'cloud-hypervisor'],
  ] as const)('normalizes primary runtime %s to %s', (runtime, expected) => {
    expect(resolvePrimaryRuntimeBackend(runtime)).toBe(expected);
  });

  it('requires the exact runsc registration for gVisor without downgrade', async () => {
    runtimeAvailable.mockResolvedValue(false);
    await expect(assertPrimaryRuntimeAvailable(
      'gvisor',
      runtimeAvailable,
      dockerAvailable,
      sbxAvailable,
    )).rejects.toThrow(/requires the "runsc" OCI runtime.*never fall back/);
    expect(runtimeAvailable).toHaveBeenCalledWith('runsc');
  });

  it('requires the selected primary sbx runtime without downgrade', async () => {
    sbxAvailable.mockResolvedValue(false);
    await expect(assertPrimaryRuntimeAvailable(
      'sbx',
      runtimeAvailable,
      dockerAvailable,
      sbxAvailable,
    )).rejects.toThrow(/sbx.*unavailable.*never fall back/);
  });

  it('fails closed when Docker is unavailable for either executor', async () => {
    dockerAvailable.mockResolvedValue(false);
    await expect(assertScriptRuntimeAvailable(
      { ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'docker' },
      runtimeAvailable,
      dockerAvailable,
    )).rejects.toThrow(/Docker daemon; enclaves never fall back/);
    await expect(assertAgentRuntimeAvailable(
      { ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'docker' },
      runtimeAvailable,
      dockerAvailable,
    )).rejects.toThrow(/Docker daemon; enclaves never fall back/);
  });

  it('rejects the unimplemented sbx executor backend without probing alternatives', async () => {
    await expect(assertScriptRuntimeAvailable(
      { ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'sbx' },
      runtimeAvailable,
      dockerAvailable,
    )).rejects.toThrow(/not implemented and never falls back/);
    expect(runtimeAvailable).not.toHaveBeenCalled();
    expect(dockerAvailable).not.toHaveBeenCalled();
  });

  it('rejects cloud-hypervisor without trusted full preflight, probing, or fallback', async () => {
    await expect(assertScriptRuntimeAvailable(
      { ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'cloud-hypervisor' },
      runtimeAvailable,
      dockerAvailable,
    )).rejects.toThrow(/trusted full host\/artifact\/storage preflight.*AWF-owned host executor.*never fall back/);
    await expect(assertAgentRuntimeAvailable(
      { ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'cloud-hypervisor' },
      runtimeAvailable,
      dockerAvailable,
    )).rejects.toThrow(/trusted full host\/artifact\/storage preflight.*AWF-owned host executor.*never fall back/);
    expect(runtimeAvailable).not.toHaveBeenCalled();
    expect(dockerAvailable).not.toHaveBeenCalled();
  });

  it('rejects an unregistered run even when a caller supplies trusted runtime configuration', async () => {
    const run = { workDir: '/unregistered-run' } as WrapperConfig;
    await expect(assertScriptRuntimeAvailable(
      { ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'cloud-hypervisor' },
      runtimeAvailable, dockerAvailable, run,
    )).rejects.toThrow(/full preflight has not completed/);
    await expect(assertAgentRuntimeAvailable(
      { ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS, enabled: true, runtime: 'cloud-hypervisor' },
      runtimeAvailable, dockerAvailable, run,
    )).rejects.toThrow(/full preflight has not completed/);
    expect(runtimeAvailable).not.toHaveBeenCalled();
    expect(dockerAvailable).not.toHaveBeenCalled();
  });
});
