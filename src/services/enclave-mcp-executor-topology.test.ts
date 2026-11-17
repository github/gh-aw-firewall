import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import type { EnclaveRuntime } from '../types/enclave-options';
import {
  resolveEnclaveMcpExecutorTopology,
  validateEnclaveMcpExecutors,
} from './enclave-mcp-executor-topology';

function executors(scriptRuntime: EnclaveRuntime = 'docker', agentRuntime: EnclaveRuntime = 'docker') {
  const repos = [{ repo: 'octo/private', sensitivity: 'internal' as const }];
  return normalizeEnclavesConfig([
    { script: {}, runtime: scriptRuntime, repos },
    { agent: { model: 'trusted-model' }, runtime: agentRuntime, repos },
  ])!;
}

describe('resolveEnclaveMcpExecutorTopology', () => {
  it.each(['docker', 'gvisor', 'cloud-hypervisor'] as const)(
    'selects the %s topology for either or both enabled roles',
    (runtime) => {
      const { script, agent } = executors(runtime, runtime).executors;
      const expected = {
        localExecutor: runtime === 'gvisor',
        hostExecutor: runtime !== 'gvisor',
      };
      expect(resolveEnclaveMcpExecutorTopology(script, agent)).toEqual(expected);
      expect(resolveEnclaveMcpExecutorTopology(script, undefined)).toEqual(expected);
      expect(resolveEnclaveMcpExecutorTopology(undefined, agent)).toEqual(expected);
    },
  );

  it.each([
    ['docker', 'gvisor', /cannot share a broker/],
    ['gvisor', 'docker', /cannot share a broker/],
    ['docker', 'cloud-hypervisor', /cannot be mixed/],
    ['gvisor', 'cloud-hypervisor', /cannot be mixed/],
    ['cloud-hypervisor', 'docker', /cannot be mixed/],
    ['cloud-hypervisor', 'gvisor', /cannot be mixed/],
  ] as const)('rejects a %s script and %s agent', (scriptRuntime, agentRuntime, error) => {
    const { script, agent } = executors(scriptRuntime, agentRuntime).executors;
    expect(() => resolveEnclaveMcpExecutorTopology(script, agent)).toThrow(error);
  });

  it('ignores disabled roles when checking mixed runtimes and image overrides', () => {
    const { script, agent } = executors('cloud-hypervisor', 'gvisor').executors;
    agent.enabled = false;
    agent.image = 'unused:test';
    expect(resolveEnclaveMcpExecutorTopology(script, agent)).toEqual({
      localExecutor: false, hostExecutor: true,
    });
    script.enabled = false;
    agent.enabled = true;
    expect(resolveEnclaveMcpExecutorTopology(script, agent)).toEqual({
      localExecutor: true, hostExecutor: false,
    });
    expect(resolveEnclaveMcpExecutorTopology(undefined, undefined)).toEqual({
      localExecutor: false, hostExecutor: false,
    });
  });

  it('rejects dynamic Cloud Hypervisor agents even without image overrides', () => {
    const { script, agent } = executors('cloud-hypervisor', 'cloud-hypervisor').executors;
    agent.dynamic = { sensitivity: 'internal' } as NonNullable<typeof agent.dynamic>;
    expect(() => resolveEnclaveMcpExecutorTopology(script, agent))
      .toThrow(/static entries and release-attested artifacts/);
  });
});

describe('validateEnclaveMcpExecutors', () => {
  it('rejects absent, globally disabled, and individually disabled executors', () => {
    const enclaves = executors();
    const config = { enclaves, enableApiProxy: true } as WrapperConfig;
    expect(validateEnclaveMcpExecutors(config)).toBe(enclaves);
    expect(() => validateEnclaveMcpExecutors({ ...config, enclaves: undefined }))
      .toThrow(/at least one enclave executor/);
    enclaves.enabled = false;
    expect(() => validateEnclaveMcpExecutors(config)).toThrow(/at least one enclave executor/);
    enclaves.enabled = true;
    enclaves.executors.script.enabled = false;
    enclaves.executors.agent.enabled = false;
    expect(() => validateEnclaveMcpExecutors(config)).toThrow(/at least one enclave executor/);
  });

  it.each(['script', 'agent'] as const)('rejects an enabled sbx %s executor', (kind) => {
    const enclaves = executors();
    enclaves.executors[kind].runtime = 'sbx';
    expect(() => validateEnclaveMcpExecutors({ enclaves, enableApiProxy: true } as WrapperConfig))
      .toThrow(`sbx ${kind} enclave capability is not yet available`);
  });

  it('requires an API proxy only for an enabled agent', () => {
    const enclaves = executors();
    const config = { enclaves, enableApiProxy: false } as WrapperConfig;
    expect(() => validateEnclaveMcpExecutors(config)).toThrow(/requires the API proxy/);
    enclaves.executors.agent.enabled = false;
    enclaves.executors.agent.runtime = 'sbx';
    expect(validateEnclaveMcpExecutors(config)).toBe(enclaves);
  });
});
