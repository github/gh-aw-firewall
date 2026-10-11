import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { isCloudHypervisorScriptAcceptanceWorkflow } from './cloud-hypervisor-script-acceptance';

const ACCEPTANCE_REF =
  'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor.lock.yml@refs/tags/v0.28.51';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'cloud-hypervisor',
    cloudHypervisor: { artifactReleaseTag: 'v0.28.51' } as WrapperConfig['cloudHypervisor'],
    enclaves: normalizeEnclavesConfig([{
      script: {},
      runtime: 'cloud-hypervisor',
      repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
      maxInvocations: 1,
    }]),
    ...overrides,
  } as WrapperConfig;
}

describe('isCloudHypervisorScriptAcceptanceWorkflow', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'github/gh-aw-firewall',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: ACCEPTANCE_REF,
      GITHUB_REF: 'refs/tags/v0.28.51',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.28.51',
    };
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  it('allows only the tagged manual public single-use script acceptance workflow', () => {
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config())).toBe(true);
  });

  it.each([
    ['a branch ref', { GITHUB_REF: 'refs/heads/main' }],
    ['a mismatched release tag', { GITHUB_REF_NAME: 'v0.28.52' }],
    ['a non-tag reference', { GITHUB_REF_TYPE: 'branch' }],
    ['a different event', { GITHUB_EVENT_NAME: 'push' }],
    ['a different repository', { GITHUB_REPOSITORY: 'attacker/gh-aw-firewall' }],
    ['a different workflow', {
      GITHUB_WORKFLOW_REF: 'github/gh-aw-firewall/.github/workflows/other.lock.yml@refs/tags/v0.28.51',
    }],
  ])('rejects %s', (_description, environment) => {
    Object.assign(process.env, environment);
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config())).toBe(false);
  });

  it.each([
    ['a non-Cloud-Hypervisor primary', { containerRuntime: 'docker' }],
    ['multiple invocations', {
      enclaves: normalizeEnclavesConfig([{
        script: {},
        runtime: 'cloud-hypervisor',
        repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
        maxInvocations: 2,
      }]),
    }],
    ['a private fixture', {
      enclaves: normalizeEnclavesConfig([{
        script: {},
        runtime: 'cloud-hypervisor',
        repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'internal' }],
        maxInvocations: 1,
      }]),
    }],
  ])('rejects %s', (_description, overrides) => {
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config(overrides))).toBe(false);
  });
});
