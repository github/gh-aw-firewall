import {
  ENCLAVE_RESOURCE_POLICIES,
  createEnclaveExecutionIdentity,
  normalizeAgentPolicy,
  sameEnclaveResourcePolicy,
  type HostExecutorAgentPolicy,
} from './execution-policy';
import { enclaveStorageRequirement, verifyBoundedInvocationStorage } from './bounded-storage';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';

const agentPolicy: HostExecutorAgentPolicy = {
  model: 'trusted-model',
  profile: 'openai',
  maxOutputBytes: 4096,
};

describe('backend-neutral enclave execution policy', () => {
  it.each(['script', 'agent'] as const)('keeps the %s role resource and storage policies closed', async (role) => {
    const profile = ENCLAVE_RESOURCE_POLICIES[role];
    expect(Object.isFrozen(ENCLAVE_RESOURCE_POLICIES)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(profile).toMatchObject({ role, uid: 65534, gid: 65534, vcpuCount: 1, cpuQuotaMilli: 500 });
    expect(sameEnclaveResourcePolicy({ ...profile }, profile)).toBe(true);
    expect(sameEnclaveResourcePolicy({ ...profile, uid: 0 }, profile)).toBe(false);
    expect(sameEnclaveResourcePolicy({ ...profile, extra: true } as never, profile)).toBe(false);
    expect(sameEnclaveResourcePolicy(undefined, profile)).toBe(false);
    const requirement = enclaveStorageRequirement(role);
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(requirement).toEqual({
      role, maximumBytes: profile.writableStorageBytes, uid: profile.uid, gid: profile.gid,
    });
    const verify = jest.fn().mockResolvedValue(undefined);
    await verifyBoundedInvocationStorage(role, '/trusted/invocation', verify, ['/trusted/invocation/output']);
    expect(verify).toHaveBeenCalledWith('/trusted/invocation', requirement, ['/trusted/invocation/output']);
    verify.mockRejectedValue(new Error('capacity could not be verified'));
    await expect(verifyBoundedInvocationStorage(role, '/trusted/invocation', verify))
      .rejects.toThrow('capacity could not be verified');
  });

  it.each(['script', 'agent'] as const)('derives a frozen %s identity from host identifiers', (role) => {
    const identity = createEnclaveExecutionIdentity(role, 'trusted-entry', 'invocation.1');
    expect(identity).toEqual({ kind: `${role}-enclave`, ownerId: 'trusted-entry', invocationId: 'invocation.1' });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() => createEnclaveExecutionIdentity(role, '../entry', 'invocation')).toThrow(/owner identity/);
    expect(() => createEnclaveExecutionIdentity(role, 'entry', 'bad/invocation')).toThrow(/invocation identity/);
  });

  it('accepts absent script policies and valid trusted agent settings without changing them', () => {
    expect(normalizeAgentPolicy(undefined, 1000)).toBeUndefined();
    expect(normalizeAgentPolicy(agentPolicy, 1000)).toBe(agentPolicy);
    expect(normalizeAgentPolicy({
      ...agentPolicy, maxModelRequests: 1, maxModelTokens: 128,
      githubAgentId: 'entry-1', githubBearer: 'x'.repeat(32),
    }, 1000)).toMatchObject({ githubAgentId: 'entry-1' });
  });

  it.each([
    { model: '' }, { model: 'x'.repeat(257) }, { model: 'é'.repeat(129) }, { model: 'model\n' },
    { profile: 'unknown' }, { maxOutputBytes: 0 }, { maxOutputBytes: HOST_EXECUTOR_MAX_RESULT_BYTES + 1 },
    { maxOutputBytes: 1.5 }, { maxModelRequests: 0 }, { maxModelTokens: -1 },
  ])('rejects invalid trusted agent settings: %j', (override) => {
    expect(() => normalizeAgentPolicy({ ...agentPolicy, ...override } as HostExecutorAgentPolicy, 1000))
      .toThrow(/agent policy is invalid/);
  });

  it.each([0, -1, 1.5, NaN])('rejects an invalid trusted deadline %s', (timeout) => {
    expect(() => normalizeAgentPolicy(agentPolicy, timeout)).toThrow(/agent policy is invalid/);
  });

  it.each([
    { githubAgentId: 'agent' },
    { githubAgentId: '../agent', githubBearer: 'x'.repeat(32) },
    { githubAgentId: 'agent', githubBearer: 'short' },
    { githubAgentId: 'agent', githubBearer: `${'x'.repeat(32)}\n` },
  ])('rejects partial or malformed GitHub credential handoffs: %j', (credentials) => {
    expect(() => normalizeAgentPolicy({ ...agentPolicy, ...credentials }, 1000)).toThrow(/GitHub/);
  });

  it('accepts a bearer-only scoped GitHub capability', () => {
    expect(normalizeAgentPolicy({
    ...agentPolicy, githubBearer: 'x'.repeat(32),
    }, 1000)).toMatchObject({ githubBearer: 'x'.repeat(32) });
  });
});
