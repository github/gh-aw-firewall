import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import type { EnclaveDynamicPolicy, EnclavesConfig } from '../types/enclave-options';
import { isCloudHypervisorScriptAcceptanceWorkflow } from './cloud-hypervisor-script-acceptance';

const ACCEPTANCE_WORKFLOW_PATH =
  'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor.lock.yml';
const ACCEPTANCE_TAG_REF = `${ACCEPTANCE_WORKFLOW_PATH}@refs/tags/v0.28.51`;
const ACCEPTANCE_MAIN_REF = `${ACCEPTANCE_WORKFLOW_PATH}@refs/heads/main`;
const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';

function baseEnclaves(): EnclavesConfig {
  return normalizeEnclavesConfig([{
    script: {},
    runtime: 'cloud-hypervisor',
    repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
    maxInvocations: 1,
  }])!;
}

function buildEnclaves(modifier: (cfg: EnclavesConfig) => void): EnclavesConfig {
  const cfg = baseEnclaves();
  modifier(cfg);
  return cfg;
}

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'cloud-hypervisor',
    cloudHypervisor: { artifactReleaseTag: 'v0.28.51' } as WrapperConfig['cloudHypervisor'],
    enclaves: baseEnclaves(),
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
      GITHUB_WORKFLOW_REF: ACCEPTANCE_TAG_REF,
      GITHUB_REF: 'refs/tags/v0.28.51',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: 'v0.28.51',
    };
    delete process.env.GITHUB_SHA;
    delete process.env.GITHUB_WORKFLOW_SHA;
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  it('allows the tagged manual public single-use script acceptance workflow', () => {
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config())).toBe(true);
  });

  it('allows the reviewed manual public script acceptance workflow running on main', () => {
    process.env.GITHUB_WORKFLOW_REF = ACCEPTANCE_MAIN_REF;
    process.env.GITHUB_REF = 'refs/heads/main';
    process.env.GITHUB_REF_TYPE = 'branch';
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_SHA = VALID_SHA;
    process.env.GITHUB_WORKFLOW_SHA = VALID_SHA;

    expect(isCloudHypervisorScriptAcceptanceWorkflow(config({
      cloudHypervisor: { artifactReleaseTag: 'v0.28.52' } as WrapperConfig['cloudHypervisor'],
    }))).toBe(true);
  });

  it('allows the main workflow when GITHUB_WORKFLOW_REF is pinned to the commit SHA', () => {
    process.env.GITHUB_WORKFLOW_REF = `${ACCEPTANCE_WORKFLOW_PATH}@${VALID_SHA}`;
    process.env.GITHUB_REF = 'refs/heads/main';
    process.env.GITHUB_REF_TYPE = 'branch';
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_SHA = VALID_SHA;
    process.env.GITHUB_WORKFLOW_SHA = VALID_SHA;

    expect(isCloudHypervisorScriptAcceptanceWorkflow(config({
      cloudHypervisor: { artifactReleaseTag: 'v0.28.52' } as WrapperConfig['cloudHypervisor'],
    }))).toBe(true);
  });

  it('allows the main workflow when GITHUB_WORKFLOW_SHA is omitted', () => {
    process.env.GITHUB_WORKFLOW_REF = ACCEPTANCE_MAIN_REF;
    process.env.GITHUB_REF = 'refs/heads/main';
    process.env.GITHUB_REF_TYPE = 'branch';
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_SHA = VALID_SHA;
    delete process.env.GITHUB_WORKFLOW_SHA;

    expect(isCloudHypervisorScriptAcceptanceWorkflow(config({
      cloudHypervisor: { artifactReleaseTag: 'v0.28.52' } as WrapperConfig['cloudHypervisor'],
    }))).toBe(true);
  });

  it('allows imageTag when its release version matches artifactReleaseTag', () => {
    process.env.GITHUB_WORKFLOW_REF = ACCEPTANCE_MAIN_REF;
    process.env.GITHUB_REF = 'refs/heads/main';
    process.env.GITHUB_REF_TYPE = 'branch';
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_SHA = VALID_SHA;
    process.env.GITHUB_WORKFLOW_SHA = VALID_SHA;

    expect(isCloudHypervisorScriptAcceptanceWorkflow(config({
      imageTag: '0.28.52,squid=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      cloudHypervisor: { artifactReleaseTag: 'v0.28.52' } as WrapperConfig['cloudHypervisor'],
    }))).toBe(true);
  });

  it.each([
    ['an arbitrary branch ref', { GITHUB_REF: 'refs/heads/feature', GITHUB_REF_NAME: 'feature' }],
    ['a PR ref', { GITHUB_REF: 'refs/pull/42/merge', GITHUB_REF_NAME: '42/merge' }],
    ['a PR head ref', { GITHUB_REF: 'refs/pull/42/head', GITHUB_REF_NAME: '42/head' }],
    ['a mismatched release tag', { GITHUB_REF_NAME: 'v0.28.52' }],
    ['a non-tag reference for tagged ref', { GITHUB_REF_TYPE: 'branch' }],
    ['a different event', { GITHUB_EVENT_NAME: 'push' }],
    ['a pull_request event', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['a schedule event', { GITHUB_EVENT_NAME: 'schedule' }],
    ['a different repository', { GITHUB_REPOSITORY: 'attacker/gh-aw-firewall' }],
    ['missing GITHUB_ACTIONS', { GITHUB_ACTIONS: undefined }],
    ['GITHUB_ACTIONS not true', { GITHUB_ACTIONS: 'false' }],
    ['a different workflow', {
      GITHUB_WORKFLOW_REF: 'github/gh-aw-firewall/.github/workflows/other.lock.yml@refs/tags/v0.28.51',
    }],
  ])('rejects tagged context with %s', (_description, environment) => {
    Object.assign(process.env, environment);
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config())).toBe(false);
  });

  it.each([
    ['missing GITHUB_SHA', { GITHUB_SHA: undefined, GITHUB_WORKFLOW_SHA: undefined }],
    ['empty GITHUB_SHA', { GITHUB_SHA: '', GITHUB_WORKFLOW_SHA: undefined }],
    ['short GITHUB_SHA', { GITHUB_SHA: '0123456789abcdef', GITHUB_WORKFLOW_SHA: undefined }],
    ['non-hex GITHUB_SHA', { GITHUB_SHA: '0123456789abcdef0123456789abcdef0123456g', GITHUB_WORKFLOW_SHA: undefined }],
    ['mismatched GITHUB_WORKFLOW_SHA', {
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: 'fedcba9876543210fedcba9876543210fedcba98',
    }],
    ['non-hex GITHUB_WORKFLOW_SHA', {
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: 'not-a-valid-sha',
    }],
    ['wrong workflow file on main', {
      GITHUB_WORKFLOW_REF: 'github/gh-aw-firewall/.github/workflows/build.lock.yml@refs/heads/main',
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
    ['workflow ref with wrong branch', {
      GITHUB_WORKFLOW_REF: `${ACCEPTANCE_WORKFLOW_PATH}@refs/heads/dev`,
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
    ['workflow ref with mismatched commit SHA', {
      GITHUB_WORKFLOW_REF: `${ACCEPTANCE_WORKFLOW_PATH}@fedcba9876543210fedcba9876543210fedcba98`,
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
    ['wrong branch name', {
      GITHUB_REF_NAME: 'dev',
      GITHUB_REF: 'refs/heads/dev',
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
    ['tag ref type on main ref', {
      GITHUB_REF_TYPE: 'tag',
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
    ['fork repository on main', {
      GITHUB_REPOSITORY: 'fork-owner/gh-aw-firewall',
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
    ['push event on main', {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_SHA: VALID_SHA,
      GITHUB_WORKFLOW_SHA: VALID_SHA,
    }],
  ])('rejects main context with %s', (_description, environment) => {
    process.env.GITHUB_WORKFLOW_REF = ACCEPTANCE_MAIN_REF;
    process.env.GITHUB_REF = 'refs/heads/main';
    process.env.GITHUB_REF_TYPE = 'branch';
    process.env.GITHUB_REF_NAME = 'main';
    Object.assign(process.env, environment);
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config())).toBe(false);
  });

  it.each([
    ['missing artifactReleaseTag', { artifactReleaseTag: undefined }],
    ['empty artifactReleaseTag', { artifactReleaseTag: '' }],
    ['artifactReleaseTag without v prefix', { artifactReleaseTag: '0.28.51' }],
    ['artifactReleaseTag with prerelease', { artifactReleaseTag: 'v0.28.51-rc1' }],
    ['unattested development artifact bypass', {
      artifactReleaseTag: 'v0.28.51',
      developmentAllowUnattestedArtifacts: true,
    }],
    ['caller-supplied sha256 digests', {
      artifactReleaseTag: 'v0.28.51',
      sha256: {
        cloudHypervisor: 'a',
        virtiofsd: 'b',
        kernel: 'c',
        rootfs: 'd',
        supervisor: 'e',
      },
    }],
  ])('rejects runtime artifact inconsistency: %s', (_description, chOverrides) => {
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config({
      cloudHypervisor: chOverrides as WrapperConfig['cloudHypervisor'],
    }))).toBe(false);
  });

  it.each([
    ['imageTag mismatch with artifactReleaseTag', {
      imageTag: '0.28.50',
      cloudHypervisor: { artifactReleaseTag: 'v0.28.51' } as WrapperConfig['cloudHypervisor'],
    }],
    ['malformed imageTag', {
      imageTag: '',
      cloudHypervisor: { artifactReleaseTag: 'v0.28.51' } as WrapperConfig['cloudHypervisor'],
    }],
  ])('rejects imageTag inconsistency: %s', (_description, overrides) => {
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config(overrides))).toBe(false);
  });

  it.each([
    ['a non-Cloud-Hypervisor primary', { containerRuntime: 'docker' as const }],
    ['enclaves disabled', {
      enclaves: buildEnclaves(c => { c.enabled = false; }),
    }],
    ['script runtime not cloud-hypervisor', {
      enclaves: buildEnclaves(c => { c.executors.script.runtime = 'docker'; }),
    }],
    ['multiple script invocations', {
      enclaves: buildEnclaves(c => { c.executors.script.maxInvocations = 2; }),
    }],
    ['zero script invocations', {
      enclaves: buildEnclaves(c => { c.executors.script.maxInvocations = 0; }),
    }],
    ['custom script image override', {
      enclaves: buildEnclaves(c => { c.executors.script.image = 'custom-image:latest'; }),
    }],
    ['agent enclave enabled', {
      enclaves: buildEnclaves(c => { c.executors.agent.enabled = true; }),
    }],
    ['dynamic admission configured', {
      enclaves: buildEnclaves(c => {
        c.executors.agent.dynamic = {} as unknown as EnclaveDynamicPolicy;
      }),
    }],
    ['a private fixture', {
      enclaves: buildEnclaves(c => { c.privateRepos[0].sensitivity = 'internal'; }),
    }],
    ['a different repository fixture', {
      enclaves: buildEnclaves(c => { c.privateRepos[0].repo = 'github/gh-aw'; }),
    }],
    ['multiple repository fixtures', {
      enclaves: buildEnclaves(c => {
        c.privateRepos.push({ repo: 'github/gh-aw', sensitivity: 'public' });
      }),
    }],
  ])('rejects enclave configuration: %s', (_description, overrides) => {
    expect(isCloudHypervisorScriptAcceptanceWorkflow(config(overrides))).toBe(false);
  });
});
