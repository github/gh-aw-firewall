import { agentEnvironment } from '../cloud-hypervisor/enclave-invocation-staging';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { normalizeAgentPolicy } from './execution-policy';
import type { EnclaveAgentEngine, EnclaveAgentProfile } from '../types/enclave-options';

/* eslint-disable @typescript-eslint/no-require-imports */
const { deriveEnclaveContainerSpec } = require('../../containers/enclave/agent-executor/enclave-runner-spec');
const { decodeCapability } = require('../../containers/api-proxy/enclave-model-budget');
/* eslint-enable @typescript-eslint/no-require-imports */

const plan: HostExecutorInvocationPlan = {
  runId: 'a'.repeat(32), entryId: 'agent', invocationId: 'b'.repeat(32),
  executorKind: 'agent', timeoutMs: 360_000, requestHash: 'c'.repeat(64),
  admissionId: 'd'.repeat(32), schemaHash: 'e'.repeat(64), schema: { type: 'boolean' },
  payload: 'test', invocationHostDir: '/private/invocation',
  seedId: 'f'.repeat(32), seedHostPath: '/private/seed',
};

const cases: Array<[EnclaveAgentEngine, EnclaveAgentProfile, number, string, string]> = [
  ['copilot', 'openai', 10002, 'COPILOT_TOKEN', 'COPILOT_API_URL'],
  ['codex', 'openai', 10000, 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  ['claude', 'anthropic', 10001, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
];

describe.each(['docker', 'cloud-hypervisor'])('%s enclave provider environment', runtime => {
  it.each(cases)('routes %s to its selected provider with scoped capability auth', (engine, profile, port, auth, url) => {
    const secret = 'a'.repeat(64);
    const endpoint = `http://172.31.0.30:${port}`;
    let environment: Record<string, string>;
    if (runtime === 'cloud-hypervisor') {
      environment = agentEnvironment({
        engine, profile, model: 'trusted', maxOutputBytes: 8192,
        maxModelRequests: 2, maxModelTokens: 128, modelBudgetSecret: secret,
      }, plan);
    } else {
      const { launchArgs } = deriveEnclaveContainerSpec({ config: {
        engine, profile, model: 'trusted', apiEndpoint: endpoint,
        hostWorkDir: '/private/work', hostSeedsDir: '/private/seeds',
        enclaveMountDir: '/agent', enclaveSeedPath: '/awf/seed',
        enclaveTaskPath: '/awf/task.txt', enclaveSchemaPath: '/awf/schema.json',
        enclaveSeccompPath: '/private/seccomp.json', enclaveImage: 'enclave:test',
        enclaveUid: 65534, enclaveGid: 65534, network: 'awf-enclave-agent',
        memoryLimit: '768m', tmpfsLimit: '96m', cpuLimit: 0.5,
        pidsLimit: 47, timeoutSeconds: 360, maxOutputBytes: 8192,
        maxModelRequests: 2, maxModelTokens: 128, modelBudgetSecret: secret,
      }, runId: plan.runId, invocationId: plan.invocationId, seedId: plan.seedId });
      environment = Object.fromEntries(launchArgs.flatMap((arg: string, index: number) => {
        if (arg !== '--env') return [];
        const value = launchArgs[index + 1] as string;
        const separator = value.indexOf('=');
        return [[value.slice(0, separator), value.slice(separator + 1)]];
      }));
      expect(launchArgs).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL']));
    }
    expect(environment.AWF_ENCLAVE_AGENT_ENGINE).toBe(engine);
    expect(environment[url]).toBe(`${endpoint}${engine === 'codex' ? '/v1' : ''}`);
    const authorization = engine === 'copilot' ? environment[auth] : `Bearer ${environment[auth]}`;
    expect(decodeCapability(authorization, secret)).toEqual({
      v: 1, invocationId: plan.invocationId, maxRequests: 2, maxTokens: 128,
    });
    expect(JSON.stringify(environment)).not.toContain(secret);
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
    for (const [other, , , otherAuth] of cases) {
      if (other !== engine) expect(environment[otherAuth]).toBeUndefined();
    }
  });
});

it.each([
  { engine: 'codex', profile: 'anthropic' },
  { engine: 'claude', profile: 'openai' },
  { engine: 'gemini', profile: 'openai' },
] as const)('rejects invalid trusted engine/profile policy %j', override => {
  expect(() => normalizeAgentPolicy({ ...override, model: 'trusted', maxOutputBytes: 8192 }, 1000))
    .toThrow(/policy is invalid/);
});
