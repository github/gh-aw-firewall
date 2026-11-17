import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import type { HostExecutorAgentPolicy } from './enclave-executor-types';
import { assertGithubCapabilityLifetime } from './host-enclave-workload-profile';

describe('host enclave GitHub capability lifetime', () => {
  const now = 1_800_000_000_000;
  const timeoutMs = 60_000;
  const policy: HostExecutorAgentPolicy = {
    model: 'gpt-4.1',
    profile: 'openai',
    maxOutputBytes: 4096,
    githubBearer: 'fixture-bearer',
    githubAllowedTools: ['issue_read'],
    githubExpiresAt: now + timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS,
  };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('permits GitHub-free policies and capabilities covering the exact deadline', () => {
    expect(() => assertGithubCapabilityLifetime(undefined, timeoutMs)).not.toThrow();
    expect(() => assertGithubCapabilityLifetime({
      model: policy.model, profile: policy.profile, maxOutputBytes: policy.maxOutputBytes,
    }, timeoutMs)).not.toThrow();
    expect(() => assertGithubCapabilityLifetime(policy, timeoutMs)).not.toThrow();
    expect(() => assertGithubCapabilityLifetime({
      ...policy, githubBearer: undefined, githubAgentId: 'fixture-agent',
    }, timeoutMs)).not.toThrow();
  });

  it.each([
    { githubExpiresAt: policy.githubExpiresAt! - 1 },
    { githubExpiresAt: undefined },
    { githubExpiresAt: Number.NaN },
    { githubBearer: undefined },
    { githubAllowedTools: undefined },
    { githubAllowedTools: [] },
    { githubAllowedTools: ['issue_read', 'issue_read'] },
    { githubAllowedTools: ['unknown-tool'] as never },
  ])('rejects incomplete or expired capabilities: %j', (invalid) => {
    expect(() => assertGithubCapabilityLifetime({ ...policy, ...invalid }, timeoutMs))
      .toThrow(/must include tools and cover the invocation deadline/);
  });
});
