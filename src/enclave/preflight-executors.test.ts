import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { resolveEnclaveAgentApiRoute as publicApiRoute, type ValidateEnclavesOptions } from './preflight';
import { resolveEnclaveAgentApiRoute, validateEnclaveExecutors } from './preflight-executors';

describe('validateEnclaveExecutors', () => {
  const config = { enableApiProxy: true, copilotGithubToken: 'test-token' } as WrapperConfig;

  it('validates both executors without clearing earlier errors', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
      { agent: { model: 'trusted' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ])!;
    const errors = ['previous error'];

    validateEnclaveExecutors(config, enclaves, {}, errors);

    expect(errors).toEqual(['previous error']);
  });

  it('does not validate controls on disabled executors', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, timeout: 0 },
      { agent: { model: '' }, timeout: 0 },
    ])!;
    enclaves.executors.script.enabled = false;
    enclaves.executors.agent.enabled = false;
    const errors: string[] = [];

    validateEnclaveExecutors(config, enclaves, {}, errors);

    expect(errors).toEqual(['enclaves is enabled but no enclave executor entry is configured']);
  });

  it('rejects static/dynamic conflicts without validating or authorizing the dynamic policy', () => {
    const enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted' },
      repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
    }])!;
    enclaves.executors.agent.dynamic = typedDynamicEnclavePolicyFixture();
    enclaves.executors.agent.dynamic.maxRepositories = 0;
    const errors: string[] = [];
    const options: ValidateEnclavesOptions = { requireDelegationHandoff: true };

    validateEnclaveExecutors(config, enclaves, options, errors);

    expect(errors).toEqual([
      'enclaves[].dynamic and enclaves[].repos are mutually exclusive: an entry declares a static ' +
      'seed catalog or a dynamic policy, never both',
    ]);
  });

  it('retains the public API-route export', () => {
    expect(publicApiRoute).toBe(resolveEnclaveAgentApiRoute);
    expect(publicApiRoute(config, { engine: 'copilot', profile: 'openai' }).routed).toBe(true);
    expect(publicApiRoute(config, { engine: 'claude', profile: 'anthropic' }).routed).toBe(false);
    expect(publicApiRoute(config, { engine: 'codex', profile: 'openai' }).routed).toBe(false);
  });
});
