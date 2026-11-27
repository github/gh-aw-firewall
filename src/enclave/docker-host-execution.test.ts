import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { getEnclaveHostDynamicAuthority } from './dynamic-delegation';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { createDockerHostAuthority } from './docker-host-authority';
import { wrapDockerHostExecution } from './docker-host-execution';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { resolveEnclavePaths } from './paths';

jest.mock('./dynamic-delegation', () => ({ getEnclaveHostDynamicAuthority: jest.fn() }));

describe('Docker host execution wrapper', () => {
  const config = {
    enclaves: normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]),
  } as WrapperConfig;
  const plan = {
    invocationId: 'd'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
  } as HostExecutorInvocationPlan;

  function setup() {
    const authority = createDockerHostAuthority(config, resolveEnclavePaths('/tmp/awf-execution-test'), 'c'.repeat(32), []);
    const service = {
      admit: jest.fn().mockResolvedValue({
        admitted: true, repository: 'octo/private', executorBearer: 'private-executor-bearer', readMode: 'live',
      }),
      settle: jest.fn().mockResolvedValue({ revoked: true }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    const backend = {
      execute: jest.fn().mockResolvedValue({ outcome: 'success', result: '{"ok":true}' }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    return { authority, service, backend, wrapped: wrapDockerHostExecution(config, backend, authority) };
  }

  it('does not acquire authority or execute when already cancelled', async () => {
    const { authority, service, backend, wrapped } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await wrapped.execute(plan, controller.signal)).toEqual({ outcome: 'cancelled' });
    expect(service.admit).not.toHaveBeenCalled();
    expect(service.settle).not.toHaveBeenCalled();
    expect(backend.execute).not.toHaveBeenCalled();
    expect(authority.authorities.size).toBe(0);
  });

  it('removes invocation authority and blocks result release and close after settlement rejection', async () => {
    const { authority, service, backend, wrapped } = setup();
    service.settle.mockRejectedValue(new Error('revocation unavailable'));
    expect(await wrapped.execute(plan, new AbortController().signal))
      .toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(authority.authorities.size).toBe(0);
    expect(authority.settlementFailed).toBe(true);
    await expect(wrapped.close!()).rejects.toThrow(/settlement requires trusted recovery/);
    expect(backend.close).toHaveBeenCalledTimes(1);
  });

  it('isolates authority state between invocations and settles each before releasing results', async () => {
    const { authority, service, wrapped } = setup();
    const other = { ...plan, invocationId: 'f'.repeat(32) };
    expect(await Promise.all([
      wrapped.execute(plan, new AbortController().signal),
      wrapped.execute(other, new AbortController().signal),
    ])).toEqual([
      { outcome: 'success', result: '{"ok":true}' }, { outcome: 'success', result: '{"ok":true}' },
    ]);
    expect(service.settle).toHaveBeenCalledTimes(2);
    for (const invocationId of [plan.invocationId, other.invocationId]) {
      expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({ invocationId, outputBytes: 11 }));
    }
    expect(authority.authorities.size).toBe(0);
    await expect(wrapped.close!()).resolves.toBeUndefined();
  });
});
