import type { AwfFileConfig } from '../../src/config-file';
import type { WrapperConfig } from '../../src/types';
import { releaseTag } from '../../src/cloud-hypervisor/artifact-compatibility.json';
import { normalizeEnclavesConfig } from '../../src/parsers/enclave-parser';
import { validateWithSchema } from '../../src/schema-validator';
import { validateEnclavesConfig } from '../../src/enclave/preflight';
import { validateRunSandboxBackend } from '../../src/enclave/run-backend';
import { mapAwfFileConfigToCliOptions } from '../../src/config-mapper';
import { applySecurityMode } from '../../src/commands/validators/security-mode';
import { isCloudHypervisorConformanceAcceptanceWorkflow } from '../../src/enclave/cloud-hypervisor-conformance-acceptance';
import {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
} from '../../src/cloud-hypervisor/runtime-validation';
import * as hostEligibility from '../../src/cloud-hypervisor/host-eligibility';
import { CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS } from '../../src/types/runtime-options';
import { getOrCreateEnclaveModelBudgetSecret } from '../../src/enclave/model-budget-capability';

const live = require('./cloud-hypervisor-enclave-live-smoke') as {
  makeConfig(artifacts: object, work: string, workspace: string, handoff: object, profile: string): AwfFileConfig;
  toAwfConfig(config: AwfFileConfig): AwfFileConfig;
};
const probe = require('./cloud-hypervisor-enclave-environment-probe') as {
  loadExampleConfig(): AwfFileConfig;
  makeProbeConfig(example: AwfFileConfig, artifacts: object, work: string, timeout: number): AwfFileConfig;
};
const artifacts = { directory: '/release', tag: releaseTag };
const workflow = 'github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor-enclaves.yml';
const sha = 'a'.repeat(40);

function generated(profile: string): AwfFileConfig {
  return profile === 'probe'
    ? probe.makeProbeConfig(probe.loadExampleConfig(), artifacts, '/tmp/work', CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS)
    : live.toAwfConfig(live.makeConfig(artifacts, '/tmp/work', '/workspace', {}, profile));
}

function normalized(raw: AwfFileConfig): WrapperConfig {
  expect(validateWithSchema(raw)).toEqual([]);
  const cliOptions = mapAwfFileConfigToCliOptions(raw);
  return {
    workDir: '/tmp/work',
    containerRuntime: raw.container?.containerRuntime,
    imageTag: raw.container?.imageTag,
    cloudHypervisor: raw.cloudHypervisor,
    networkIsolation: raw.network?.isolation,
    enableApiProxy: cliOptions.enableApiProxy as boolean | undefined,
    enclaves: normalizeEnclavesConfig(raw.enclaves, { primaryRuntime: raw.container?.containerRuntime }),
    // Only validate route presence; no provider or model calls occur.
    copilotGithubToken: 'isolated-test-route',
  } as WrapperConfig;
}

describe('generated native conformance production admission (no KVM)', () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    process.env = {
      PATH: originalEnvironment.PATH,
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'github/gh-aw-firewall',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: releaseTag,
      GITHUB_REF: `refs/tags/${releaseTag}`,
      GITHUB_WORKFLOW_REF: `${workflow}@refs/tags/${releaseTag}`,
      GITHUB_SHA: sha,
      GITHUB_WORKFLOW_SHA: sha,
      AWF_ACCEPTANCE_COMMIT: 'b'.repeat(40),
    };
    jest.spyOn(hostEligibility, 'assertGithubHostedRunnerEligibility').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = originalEnvironment;
    jest.restoreAllMocks();
  });

  it.each(['primary', 'script-only', 'agent-only', 'combined', 'probe'])(
    'admits the actual schema-valid %s profile through normalization and both production gates', profile => {
      const config = normalized(generated(profile));
      expect(config.containerRuntime).toBe('cloud-hypervisor');
      expect(config.enableApiProxy).toBeUndefined();
      expect(() => assertCloudHypervisorPreSecurityCompatibility(config)).not.toThrow();
      expect(isCloudHypervisorConformanceAcceptanceWorkflow(config)).toBe(profile !== 'primary');
      applySecurityMode(config);
      expect(config.enableApiProxy).toBe(true);
      if (config.enclaves) {
        expect(validateRunSandboxBackend(config.containerRuntime, config.enclaves)).toEqual([]);
      } else {
        expect(profile).toBe('primary');
      }
      expect(validateEnclavesConfig(config)).toEqual([]);
      expect(() => assertCloudHypervisorRuntimeCompatibility(config)).not.toThrow();
      if (profile === 'probe') {
        delete config.copilotGithubToken;
        expect(validateEnclavesConfig(config)).toEqual([]);
        expect(() => assertCloudHypervisorRuntimeCompatibility(config)).not.toThrow();
      }
    },
  );

  it.each(['agent-only', 'combined'])(
    'omits optional model-cost limits throughout the generated %s profile', profile => {
      const raw = generated(profile);
      const entry = raw.enclaves!.find(entry => entry.agent);
      expect(entry).toBeDefined();
      expect(entry!.agent).not.toHaveProperty('maxModelRequests');
      expect(entry!.agent).not.toHaveProperty('maxModelTokens');
      const config = normalized(raw);
      const agent = config.enclaves!.executors.agent;
      expect(agent.maxModelRequests).toBeUndefined();
      expect(agent.maxModelTokens).toBeUndefined();
      expect(getOrCreateEnclaveModelBudgetSecret(config)).toBeUndefined();
      expect(isCloudHypervisorConformanceAcceptanceWorkflow(config)).toBe(true);
      expect(agent).toMatchObject({
        network: 'api-proxy-only', timeout: 360, maxInvocations: 3,
        maxTaskBytes: 4096, maxOutputBytes: 8192,
      });
    },
  );

  it.each(['agent-only', 'combined'])(
    'rejects reintroduced model-cost limits in the exact %s profile', profile => {
      const base = normalized(generated(profile));
      const enclaves = base.enclaves!;
      for (const limits of [
        { maxModelRequests: 1 },
        { maxModelRequests: 2 },
        { maxModelTokens: 256 },
        { maxModelTokens: 257 },
        { maxModelRequests: 1, maxModelTokens: 256 },
      ]) {
        const config = {
          ...base,
          enclaves: {
            ...enclaves,
            executors: {
              ...enclaves.executors,
              agent: { ...enclaves.executors.agent, ...limits },
            },
          },
        };
        expect(isCloudHypervisorConformanceAcceptanceWorkflow(config)).toBe(false);
        expect(validateEnclavesConfig(config).join(';')).toMatch(/cannot be combined/);
        expect(() => assertCloudHypervisorPreSecurityCompatibility(config)).toThrow(/reserved/);
      }
    },
  );

  it.each(['script-only', 'agent-only', 'combined', 'probe'])(
    'rejects Docker-default or explicit mismatched backends in the actual %s config', profile => {
      const raw = generated(profile);
      for (const primaryRuntime of [undefined, 'docker', 'gvisor', 'sbx', 'nvx']) {
        expect(() => normalizeEnclavesConfig(raw.enclaves, { primaryRuntime }))
          .toThrow(/one sandbox backend|NVX enclaves are not implemented/);
      }
      for (const runtime of ['docker', 'gvisor', 'sbx'] as const) {
        const entries = raw.enclaves!.map(entry => ({ ...entry, runtime }));
        expect(() => normalizeEnclavesConfig(entries, { primaryRuntime: 'cloud-hypervisor' }))
          .toThrow(/one sandbox backend/);
      }
    },
  );

  it.each([
    'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_REF_TYPE',
    'GITHUB_REF_NAME', 'GITHUB_REF', 'GITHUB_WORKFLOW_REF', 'GITHUB_SHA',
    'GITHUB_WORKFLOW_SHA', 'AWF_ACCEPTANCE_COMMIT',
  ])('fails both production gates when sudo drops %s', name => {
    const config = normalized(generated('combined'));
    delete process.env[name];
    expect(isCloudHypervisorConformanceAcceptanceWorkflow(config)).toBe(false);
    expect(validateEnclavesConfig(config).join(';')).toMatch(/cannot be combined/);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(config)).toThrow(/reserved/);
  });

  it.each([
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'fork/gh-aw-firewall' },
    { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' },
    { GITHUB_WORKFLOW_REF: `${workflow}@${sha}` },
    { GITHUB_WORKFLOW_SHA: 'c'.repeat(40) },
    { GITHUB_SHA: 'short', GITHUB_WORKFLOW_SHA: 'short' },
    { AWF_ACCEPTANCE_COMMIT: 'not-a-sha' },
  ])('rejects non-release native identity %j', environment => {
    Object.assign(process.env, environment);
    expect(isCloudHypervisorConformanceAcceptanceWorkflow(normalized(generated('combined')))).toBe(false);
  });

  it('retains generic admission, artifact trust, credential isolation and workspace restrictions', () => {
    const config = normalized(generated('combined'));
    for (const changed of [
      { ...config, imageTag: 'latest' },
      { ...config, imageTag: 'v0.0.1' },
      { ...config, imageTag: undefined },
      { ...config, enableApiProxy: false },
      { ...config, cloudHypervisor: { ...config.cloudHypervisor!, artifactReleaseTag: 'v0.0.1' } },
      { ...config, cloudHypervisor: { ...config.cloudHypervisor!, developmentAllowUnattestedArtifacts: true } },
      { ...config, cloudHypervisor: { ...config.cloudHypervisor!, sha256: {} } },
    ]) expect(isCloudHypervisorConformanceAcceptanceWorkflow(changed)).toBe(false);
    expect(() => assertCloudHypervisorPreSecurityCompatibility({
      ...config, enableApiProxy: false,
    })).toThrow(/reserved/);
    expect(() => assertCloudHypervisorRuntimeCompatibility({
      ...config, enableApiProxy: false,
    })).toThrow(/API proxy credential isolation/);
    expect(() => assertCloudHypervisorPreSecurityCompatibility({
      ...config, volumeMounts: ['/tmp:/workspace:rw'],
    })).toThrow(/additional host volume mounts/);
    delete process.env.GITHUB_WORKFLOW_REF;
    expect(validateEnclavesConfig(config).join(';')).toMatch(/cannot be combined/);
  });

  it('admits a candidate only in its separately compiled same-commit profile', () => {
    const tag = `v0.0.0-candidate.${sha}`;
    const config = normalized(generated('combined'));
    config.imageTag = tag;
    config.cloudHypervisor = { ...config.cloudHypervisor!, artifactReleaseTag: tag };
    config.enableApiProxy = true;
    Object.assign(process.env, {
      AWF_ENCLAVE_ACCEPTANCE_MODE: 'candidate',
      AWF_ACCEPTANCE_COMMIT: sha,
      GITHUB_REF_TYPE: 'branch',
      GITHUB_REF_NAME: 'reviewed-candidate',
      GITHUB_REF: 'refs/heads/reviewed-candidate',
      GITHUB_WORKFLOW_REF: `${workflow}@refs/heads/reviewed-candidate`,
    });
    expect(isCloudHypervisorConformanceAcceptanceWorkflow(config)).toBe(false);
    const compatibility = '../../src/cloud-hypervisor/artifact-compatibility.json';
    try {
      jest.doMock(compatibility, () => ({
        releaseTag: tag,
        signerWorkflow: 'github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor.yml',
      }));
      jest.isolateModules(() => {
        const { isCloudHypervisorConformanceAcceptanceWorkflow: admit } =
          require('../../src/enclave/cloud-hypervisor-conformance-acceptance');
        const eligibility = require('../../src/cloud-hypervisor/host-eligibility');
        jest.spyOn(eligibility, 'assertGithubHostedRunnerEligibility').mockImplementation(() => undefined);
        const validation = require('../../src/cloud-hypervisor/runtime-validation');
        const { validateEnclavesConfig: validate } = require('../../src/enclave/preflight');
        expect(admit(config)).toBe(true);
        expect(validate(config)).toEqual([]);
        expect(() => validation.assertCloudHypervisorPreSecurityCompatibility(config)).not.toThrow();
        expect(() => validation.assertCloudHypervisorRuntimeCompatibility(config)).not.toThrow();
        for (const changed of [
          { AWF_ENCLAVE_ACCEPTANCE_MODE: 'release' },
          { AWF_ACCEPTANCE_COMMIT: 'b'.repeat(40) },
          { GITHUB_SHA: 'b'.repeat(40) },
          { GITHUB_EVENT_NAME: 'pull_request' },
          { GITHUB_REF_NAME: 'different' },
        ]) {
          const original = { ...process.env };
          Object.assign(process.env, changed);
          expect(admit(config)).toBe(false);
          process.env = original;
        }
        expect(admit({ ...config, enableApiProxy: false })).toBe(false);
        expect(admit({
          ...config, enclaves: { ...config.enclaves!, privateRepos: [] },
        })).toBe(false);
      });
    } finally {
      jest.dontMock(compatibility);
    }
  });

  it('rejects catalog, executor and budget changes instead of broadly opening primary-with-enclaves', () => {
    const base = normalized(generated('combined'));
    const enclaves = base.enclaves!;
    const { script, agent } = enclaves.executors;
    const changedExecutors = [
      { script: { ...script, runtime: 'docker' as const }, agent },
      { script: { ...script, image: 'custom:latest' }, agent },
      { script: { ...script, maxInvocations: 9 }, agent },
      { script: { ...script, timeout: 121 }, agent },
      { script: { ...script, memoryLimit: '1g' }, agent },
      { script: { ...script, maxOutputBytes: 8193 }, agent },
      { script: { ...script, maxScriptBytes: 16_385 }, agent },
      { script, agent: { ...agent, model: 'other-model' } },
      { script, agent: { ...agent, maxInvocations: 4 } },
      { script, agent: { ...agent, timeout: 180 } },
      { script, agent: { ...agent, timeout: 359 } },
      { script, agent: { ...agent, timeout: 361 } },
      { script, agent: { ...agent, maxTaskBytes: 4097 } },
      { script, agent: { ...agent, tools: { github: { allowed: [], allowedRepos: [] } } } },
    ];
    for (const executors of changedExecutors) {
      expect(isCloudHypervisorConformanceAcceptanceWorkflow({ ...base, enclaves: { ...enclaves, executors } }))
        .toBe(false);
    }
    for (const privateRepos of [[], [{ repo: 'octo/private', sensitivity: 'public' as const }],
      [{ repo: 'github/gh-aw-firewall', sensitivity: 'internal' as const }]]) {
      expect(isCloudHypervisorConformanceAcceptanceWorkflow({ ...base, enclaves: { ...enclaves, privateRepos } }))
        .toBe(false);
    }
  });
});
