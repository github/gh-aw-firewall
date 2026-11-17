import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import type { HostExecutorAgentPolicy } from './enclave-executor-types';
import { assertGithubCapabilityLifetime, resolveInvocationPolicy } from './host-enclave-executor-policy';

describe('host enclave invocation policy', () => {
  const plan = { entryId: 'entry', executorKind: 'agent', timeoutMs: 1000 } as HostExecutorInvocationPlan;
  const policy: HostExecutorAgentPolicy = { model: 'gpt-4.1', profile: 'openai', maxOutputBytes: 1024 };

  it('ignores inherited policies, including special object property names', () => {
    const policies = Object.create({ entry: policy }) as Record<string, HostExecutorAgentPolicy>;
    expect(resolveInvocationPolicy(plan, policies)).toBeUndefined();
    expect(resolveInvocationPolicy({ ...plan, entryId: 'constructor' }, {})).toBeUndefined();
    expect(resolveInvocationPolicy({ ...plan, entryId: '__proto__' }, {})).toBeUndefined();
    Object.defineProperty(policies, 'entry', { value: policy });
    expect(resolveInvocationPolicy(plan, policies)).toMatchObject(policy);
    const ownSpecial = Object.create(null) as Record<string, HostExecutorAgentPolicy>;
    ownSpecial.__proto__ = policy;
    expect(resolveInvocationPolicy({ ...plan, entryId: '__proto__' }, ownSpecial)).toMatchObject(policy);
  });

  it('ignores agent policies for script roles and leaves missing policy rejection to profile creation', () => {
    expect(resolveInvocationPolicy({ ...plan, executorKind: 'script' }, { entry: {} as HostExecutorAgentPolicy }))
      .toBeUndefined();
    expect(resolveInvocationPolicy(plan, undefined)).toBeUndefined();
  });

  it('requires capability coverage through the exact deadline plus grace on every check', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const capability = {
        ...policy, githubBearer: 'credential',
        githubExpiresAt: 10_000 + plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS,
        githubAllowedTools: ['issue_read'],
      };
      expect(() => assertGithubCapabilityLifetime(capability, plan.timeoutMs)).not.toThrow();
      now.mockReturnValue(10_001);
      expect(() => assertGithubCapabilityLifetime(capability, plan.timeoutMs)).toThrow('cover the invocation deadline');
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { githubExpiresAt: Number.MAX_SAFE_INTEGER, githubAllowedTools: ['issue_read'] },
    { githubBearer: 'credential', githubAllowedTools: ['issue_read'] },
    { githubBearer: 'credential', githubExpiresAt: Number.MAX_SAFE_INTEGER, githubAllowedTools: [] },
    { githubBearer: 'credential', githubExpiresAt: Number.MAX_SAFE_INTEGER, githubAllowedTools: ['issue_read', 'issue_read'] },
    { githubBearer: 'credential', githubExpiresAt: Number.MAX_SAFE_INTEGER, githubAllowedTools: ['unknown'] },
  ])('rejects incomplete or invalid capability metadata: %j', (metadata) => {
    expect(() => assertGithubCapabilityLifetime({ ...policy, ...metadata }, plan.timeoutMs)).toThrow();
  });

  it('permits policies with no GitHub capability', () => {
    expect(() => assertGithubCapabilityLifetime(undefined, plan.timeoutMs)).not.toThrow();
    expect(() => assertGithubCapabilityLifetime(policy, plan.timeoutMs)).not.toThrow();
  });
});
