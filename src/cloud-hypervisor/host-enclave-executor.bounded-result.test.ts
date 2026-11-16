import { agentEnvironment, stageInvocationInputs } from './enclave-invocation-staging';
import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import type { HostExecutorAgentPolicy } from './host-enclave-executor';
/* eslint-disable @typescript-eslint/no-require-imports */
const { decodeCapability } = require('../../containers/api-proxy/enclave-model-budget');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('Cloud Hypervisor enclave credential and model-budget boundaries', () => {
  it('rejects the host GitHub token in the enclave bearer file before staging inputs', async () => {
    const previousToken = process.env.GITHUB_PAT;
    const token = 'host-github-token-value';
    process.env.GITHUB_PAT = token;
    const writeFile = jest.fn();
    const plan: HostExecutorInvocationPlan = {
      runId: 'a'.repeat(32),
      entryId: 'agent-entry',
      invocationId: 'b'.repeat(32),
      executorKind: 'agent',
      timeoutMs: 1000,
      requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(32),
      schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' },
      payload: 'test',
      invocationHostDir: '/tmp/awf-enclave-invocation',
      seedId: 'f'.repeat(32),
      seedHostPath: '/tmp/awf-enclave-seed',
    };
    const policy: HostExecutorAgentPolicy = {
      model: 'trusted-model',
      profile: 'openai',
      maxOutputBytes: 4096,
      githubAgentId: 'trusted-agent-id',
      githubBearer: token,
      githubExpiresAt: Date.now() + 300_000,
      githubAllowedTools: ['issue_read', 'list_issues'],
    };

    try {
      await expect(stageInvocationInputs(plan, 'agent', policy, {
        writeFile,
        chown: jest.fn(),
        chmod: jest.fn(),
      })).rejects.toThrow(/host GitHub token through Cloud Hypervisor enclave GitHub bearer file/);
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = previousToken;
    }
  });

  it('rejects a host GitHub token copied into the enclave guest environment', () => {
    const previousToken = process.env.GITHUB_PAT;
    const token = 'host-github-token-value';
    process.env.GITHUB_PAT = token;
    const policy: HostExecutorAgentPolicy = {
      model: token,
      profile: 'openai',
      maxOutputBytes: 4096,
    };
    const plan: HostExecutorInvocationPlan = {
      runId: 'a'.repeat(32),
      entryId: 'agent-entry',
      invocationId: 'b'.repeat(32),
      executorKind: 'agent',
      timeoutMs: 1000,
      requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(32),
      schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' },
      payload: 'test',
      invocationHostDir: '/tmp/awf-enclave-invocation',
      seedId: 'f'.repeat(32),
      seedHostPath: '/tmp/awf-enclave-seed',
    };

    try {
      expect(() => agentEnvironment(policy, plan)).toThrow(
        /host GitHub token through Cloud Hypervisor enclave variable COPILOT_MODEL/,
      );
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = previousToken;
    }
  });

  it('hands the guest only an invocation-scoped signed model-budget capability', () => {
    const secret = 'a'.repeat(64);
    const policy: HostExecutorAgentPolicy = {
      model: 'trusted-model',
      profile: 'openai',
      maxOutputBytes: 4096,
      maxModelRequests: 2,
      maxModelTokens: 128,
      modelBudgetSecret: secret,
    };
    const plan: HostExecutorInvocationPlan = {
      runId: 'a'.repeat(32),
      entryId: 'agent-entry',
      invocationId: 'b'.repeat(32),
      executorKind: 'agent',
      timeoutMs: 1000,
      requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(32),
      schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' },
      payload: 'test',
      invocationHostDir: '/tmp/awf-enclave-invocation',
      seedId: 'f'.repeat(32),
      seedHostPath: '/tmp/awf-enclave-seed',
    };

    const environment = agentEnvironment(policy, plan);
    expect(environment.COPILOT_CLI_DIST_DIR).toBe('/usr/local/lib/node_modules/@github/copilot/runtime');
    expect(environment.COPILOT_GITHUB_TOKEN).toBe('******');
    expect(environment.COPILOT_TOKEN).not.toContain(secret);
    expect(decodeCapability(environment.COPILOT_TOKEN, secret)).toEqual({
      v: 1,
      invocationId: plan.invocationId,
      maxRequests: 2,
      maxTokens: 128,
    });
    expect(environment.COPILOT_PROVIDER_BEARER_TOKEN).not.toMatch(/^\u0042earer /);
    expect(decodeCapability(`\u0042earer ${environment.COPILOT_PROVIDER_BEARER_TOKEN}`, secret)).toEqual({
      v: 1,
      invocationId: plan.invocationId,
      maxRequests: 2,
      maxTokens: 128,
    });
    expect(environment.COPILOT_PROVIDER_BEARER_TOKEN).not.toContain(secret);
  });
});
