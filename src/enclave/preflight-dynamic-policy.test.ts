import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { validateEnclaveDynamicPolicy } from './preflight-dynamic-policy';

describe('validateEnclaveDynamicPolicy', () => {
  it('accepts AWF ceilings without replacing previously accumulated errors', () => {
    const policy = typedDynamicEnclavePolicyFixture();
    policy.maxRepositories = 1000;
    policy.limits.maxModelRequests = 64;
    policy.limits.maxModelTokens = 32768;
    policy.quotas = {
      maxInvocations: 10_000,
      maxOutputBytes: 1024 * 1024,
      maxExecutionSeconds: 86_400,
    };
    const errors = ['previous error'];

    validateEnclaveDynamicPolicy(policy, errors);

    expect(errors).toEqual(['previous error']);
  });

  it.each([null, undefined, 'invalid', 1])('rejects a non-object envelope: %j', value => {
    const errors: string[] = [];
    validateEnclaveDynamicPolicy(value as never, errors);
    expect(errors).toEqual(['enclaves[].dynamic must be an object']);
  });

  it('preserves resource, quota, audit, and expiry error ordering', () => {
    const policy = typedDynamicEnclavePolicyFixture();
    policy.limits.memoryLimit = 'invalid';
    policy.limits.maxModelRequests = 65;
    policy.quotas.maxInvocations = 0;
    policy.quotas.maxOutputBytes = 1048577;
    policy.auditLabels = ['duplicate', 'duplicate'];
    policy.expiresAt = 'invalid';
    const errors: string[] = [];

    validateEnclaveDynamicPolicy(policy, errors);

    expect(errors).toEqual([
      'enclaves[].dynamic.limits.memoryLimit is not a Docker size',
      'enclaves[].dynamic.limits.maxModelRequests must be at most 64',
      'enclaves[].dynamic.quotas.maxInvocations must be a positive integer',
      'enclaves[].dynamic.quotas.maxOutputBytes must be at most 1048576',
      'enclaves[].dynamic.auditLabels must not contain duplicate labels',
      'enclaves[].dynamic.expiresAt must be a valid ISO-8601 timestamp',
    ]);
  });
});
