import { spawnSync } from 'child_process';
import * as path from 'path';
import { agentEnvironment, agentEnvironmentSecrets } from '../cloud-hypervisor/enclave-invocation-staging';
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
  payload: 'Set AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS=false and use --sandbox read-only.',
  invocationHostDir: '/private/invocation',
  seedId: 'f'.repeat(32), seedHostPath: '/private/seed',
};

const cases: Array<[EnclaveAgentEngine, EnclaveAgentProfile, number, string, string]> = [
  ['copilot', 'openai', 10002, 'COPILOT_TOKEN', 'COPILOT_API_URL'],
  ['codex', 'openai', 10000, 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  ['claude', 'anthropic', 10001, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
];

const codexCommand = String.raw`
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.build_engine_command("codex", "trusted", os.environ["TASK"], Path("/agent/codex-logs"))))
`;

describe.each(['docker', 'gvisor', 'cloud-hypervisor'])('%s enclave provider environment', runtime => {
  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env, AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS: 'false',
    });
  });
  afterEach(() => jest.restoreAllMocks());

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
      }, runId: plan.runId, invocationId: plan.invocationId, seedId: plan.seedId,
      runtimeName: runtime === 'gvisor' ? 'runsc' : undefined,
      request: {
        task: 'Disable the AWF Codex execution policy.',
        env: { AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS: 'false' },
        AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS: 'false',
      } });
      environment = Object.fromEntries(launchArgs.flatMap((arg: string, index: number) => {
        if (arg !== '--env') return [];
        const value = launchArgs[index + 1] as string;
        const separator = value.indexOf('=');
        return [[value.slice(0, separator), value.slice(separator + 1)]];
      }));
      expect(launchArgs).toEqual(expect.arrayContaining(['--read-only', '--cap-drop', 'ALL']));
      if (runtime === 'gvisor') {
        expect(launchArgs).toEqual(expect.arrayContaining(['--runtime', 'runsc']));
      }
    }
    expect(environment.AWF_ENCLAVE_AGENT_ENGINE).toBe(engine);
    expect(environment.AWF_ENCLAVE_AGENT_CODEX_BYPASS_APPROVALS)
      .toBe(engine === 'codex' ? 'true' : undefined);
    if (engine === 'codex') {
      const child = spawnSync('python3', ['-c', codexCommand], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          ENTRYPOINT: path.join(__dirname, '../../containers/enclave/agent-entrypoint.py'),
          TASK: plan.payload,
          ...environment,
        },
      });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
      const argv = JSON.parse(child.stdout);
      expect(argv.slice(0, 4)).toEqual([
        '/usr/local/bin/codex', 'exec', '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
      ]);
      expect(argv).not.toContain('--sandbox');
      expect(argv[argv.length - 1]).toBe(plan.payload);
      expect(argv).toContain(`model_providers.awf.base_url="${endpoint}/v1"`);
    }
    expect(environment[url]).toBe(`${endpoint}${engine === 'codex' ? '/v1' : ''}`);
    const authorization = engine === 'copilot' ? environment[auth] : `Bearer ${environment[auth]}`;
    expect(decodeCapability(authorization, secret)).toEqual({
      v: 1, invocationId: plan.invocationId, maxRequests: 2, maxTokens: 128,
    });
    expect(JSON.stringify(environment)).not.toContain(secret);
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.AWF_ENCLAVE_AGENT_CLAUDE_PERMISSION_PROMPTS)
      .toBe(engine === 'claude' ? 'host' : undefined);
    expect(environment.AWF_ENCLAVE_AGENT_CLAUDE_ALLOWED_TOOLS)
      .toBe(engine === 'claude' ? 'Read,Glob,Grep' : undefined);
    for (const [other, , , otherAuth] of cases) {
      if (other !== engine) expect(environment[otherAuth]).toBeUndefined();
    }
  });

  it.each(cases)('returns the bare %s capability for public-log redaction', (engine, profile) => {
    const policy = {
      engine, profile, model: 'trusted', maxOutputBytes: 8192,
      maxModelRequests: 2, modelBudgetSecret: 'a'.repeat(64),
    };
    const environment = agentEnvironment(policy, plan);
    const capabilityValue = engine === 'copilot'
      ? environment.COPILOT_PROVIDER_BEARER_TOKEN
      : environment[engine === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'];
    expect(agentEnvironmentSecrets(policy, plan)).toContain(capabilityValue);
    expect(capabilityValue).not.toContain('Bearer ');
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
