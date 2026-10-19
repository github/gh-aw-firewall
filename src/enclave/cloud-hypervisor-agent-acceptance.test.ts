import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { isCloudHypervisorAgentAcceptanceWorkflow } from './cloud-hypervisor-script-acceptance';
import { validateEnclavesConfig } from './preflight';
import {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
} from '../cloud-hypervisor/runtime-validation';
import * as hostEligibility from '../cloud-hypervisor/host-eligibility';

const workflow =
  'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor-copilot.lock.yml';
const sha = '0123456789abcdef0123456789abcdef01234567';

function config(): WrapperConfig {
  return {
    workDir: '/tmp/awf',
    containerRuntime: 'cloud-hypervisor',
    networkIsolation: true,
    enableApiProxy: true,
    copilotGithubToken: 'test-host-only-token',
    cloudHypervisor: {
      previewEnabled: true,
      artifactReleaseTag: 'v0.28.66',
      mountPolicy: 'workspace-and-tool-cache',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      artifactManifestPath: '/opt/manifest.json',
      artifactManifestBundlePath: '/opt/manifest.sigstore.jsonl',
    },
    enclaves: normalizeEnclavesConfig([{
      runtime: 'cloud-hypervisor',
      agent: {
        engine: 'copilot', model: 'claude-sonnet-5',
        maxTaskBytes: 4096, maxModelRequests: 8, maxModelTokens: 32768,
      },
      repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
      maxInvocations: 1, maxOutputBytes: 256, timeout: 90,
    }], { primaryRuntime: 'cloud-hypervisor' }),
  } as WrapperConfig;
}

describe('Cloud Hypervisor primary and Copilot agent enclave acceptance', () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    jest.spyOn(hostEligibility, 'assertGithubHostedRunnerEligibility')
      .mockImplementation(() => undefined);
    process.env = {
      ...originalEnvironment,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'github/gh-aw-firewall',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/test-agent-enclave',
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'test-agent-enclave',
      GITHUB_SHA: sha,
      GITHUB_WORKFLOW_SHA: sha,
      GITHUB_WORKFLOW_REF: `${workflow}@refs/heads/test-agent-enclave`,
    };
  });
  afterEach(() => {
    process.env = originalEnvironment;
    jest.restoreAllMocks();
  });

  it('admits only the exact manual public single-use Copilot VM acceptance scope', () => {
    const value = config();
    expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(true);
    expect(validateEnclavesConfig(value)).toEqual([]);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(value)).not.toThrow();
    expect(() => assertCloudHypervisorRuntimeCompatibility(value)).not.toThrow();
    process.env.GITHUB_WORKFLOW_REF = `${workflow}@${sha}`;
    expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(true);
    process.env.GITHUB_REF_NAME = 'main';
    process.env.GITHUB_REF = 'refs/heads/main';
    process.env.GITHUB_WORKFLOW_REF = `${workflow}@refs/heads/main`;
    expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(true);
  });

  it.each([
    { GITHUB_REPOSITORY: 'fork/gh-aw-firewall' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'schedule' },
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REF_TYPE: 'tag', GITHUB_REF: 'refs/tags/v0.28.66',
      GITHUB_REF_NAME: 'v0.28.66', GITHUB_WORKFLOW_REF: `${workflow}@refs/tags/v0.28.66` },
    { GITHUB_SHA: 'invalid' },
    { GITHUB_WORKFLOW_SHA: 'a'.repeat(40) },
    { GITHUB_WORKFLOW_REF: `${workflow}@refs/heads/main` },
    { GITHUB_WORKFLOW_REF:
      'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor.lock.yml@refs/heads/test-agent-enclave' },
  ])('rejects an untrusted workflow identity: %j', environment => {
    Object.assign(process.env, environment);
    expect(isCloudHypervisorAgentAcceptanceWorkflow(config())).toBe(false);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(config()))
      .toThrow(/reserved until/);
  });

  it.each<keyof NonNullable<WrapperConfig['enclaves']>['executors']['agent']>([
    'model', 'engine', 'maxInvocations', 'maxOutputBytes', 'maxTaskBytes',
    'maxModelRequests', 'maxModelTokens', 'timeout', 'runtime', 'image',
  ])('rejects an agent setting outside the reviewed scope: %s', field => {
    const value = config();
    const agent = value.enclaves!.executors.agent;
    Object.assign(agent, { [field]: typeof agent[field] === 'number' ? 999 : 'other' });
    expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(false);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(value)).toThrow(/reserved until/);
  });

  it('rejects private fixtures, extra executors, GitHub tooling and unattested guests', () => {
    const modifications: Array<(value: WrapperConfig) => void> = [
      value => { value.enclaves!.privateRepos[0].sensitivity = 'internal'; },
      value => { value.enclaves!.privateRepos[0].repo = 'github/other'; },
      value => { value.enclaves!.executors.script.enabled = true; },
      value => { value.enclaves!.executors.agent.enabled = false; },
      value => { value.enclaves!.executors.agent.github = { cli: 'issues-read-v1' }; },
      value => { Object.assign(value.enclaves!.executors.agent, { tools: { github: {} } }); },
      value => { Object.assign(value.enclaves!.executors.agent, { dynamic: {} }); },
      value => { value.enclaves!.privateRepos.push({ repo: 'github/other', sensitivity: 'public' }); },
      value => { value.enclaves!.enabled = false; },
      value => { value.cloudHypervisor!.developmentAllowUnattestedArtifacts = true; },
      value => { value.cloudHypervisor!.sha256 = { kernel: 'a'.repeat(64) }; },
      value => { value.cloudHypervisor!.artifactReleaseTag = ''; },
      value => { value.cloudHypervisor!.artifactReleaseTag = 'v0.28.63'; },
      value => { value.imageTag = '0.28.61'; },
    ];
    for (const modify of modifications) {
      const value = config();
      modify(value);
      expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(false);
    }
  });

  it.each([2048, 32767, 32769])('rejects a token budget outside the exact smoke allowance: %s', tokens => {
    const value = config();
    value.enclaves!.executors.agent.maxModelTokens = tokens;
    expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(false);
  });

  it.each(['v0.28.62', 'v0.28.63', 'v0.28.64', 'v0.28.65', 'v0.28.67', 'latest'])(
    'rejects a guest release outside the exact v0.28.66 pin: %s', release => {
      const value = config();
      value.cloudHypervisor!.artifactReleaseTag = release;
      expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(false);
      expect(() => assertCloudHypervisorPreSecurityCompatibility(value)).toThrow(/reserved until/);
    },
  );

  it('does not admit a Docker primary or waive credential isolation', () => {
    const value = config();
    value.containerRuntime = 'docker';
    expect(isCloudHypervisorAgentAcceptanceWorkflow(value)).toBe(false);
    value.containerRuntime = 'cloud-hypervisor';
    value.copilotGithubToken = undefined;
    expect(validateEnclavesConfig(value).join(';')).toMatch(/route|configured/);
    value.enableApiProxy = false;
    expect(() => assertCloudHypervisorRuntimeCompatibility(value))
      .toThrow(/API proxy credential isolation/);
  });
});
