import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches, usesPublishedAwfRelease } from './apply-general-workflow-patches';
import { normalizeEnclavesConfig } from '../../src/parsers/enclave-parser';
import type { RawEnclavesConfig } from '../../src/types/enclave-options';
import { isCloudHypervisorAgentAcceptanceWorkflow } from '../../src/enclave/cloud-hypervisor-script-acceptance';
import { buildBranchEnclaveInstallSteps } from './workflow-step-builders';
import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } from '../../src/cloud-hypervisor/artifact-manifest';

const workflowPath = path.resolve(__dirname,
  '../../.github/workflows/smoke-enclave-cloud-hypervisor-copilot.lock.yml');
const source = fs.readFileSync(workflowPath.replace('.lock.yml', '.md'), 'utf8');
const lock = fs.readFileSync(workflowPath, 'utf8');
interface Step {
  name: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
const frontmatter = yaml.load(source.split('---')[1]) as {
  on: Record<string, unknown>;
  if: string;
  features: Record<string, boolean>;
  permissions: Record<string, string>;
  'runs-on': string;
  engine: { id: string; version: string; args: string[]; env: Record<string, string> };
  tools: Record<string, unknown>;
  enclaves: unknown[];
  sandbox: { agent: Record<string, unknown> };
  'post-steps': Step[];
};
const compiled = yaml.load(lock) as {
  jobs: Record<string, { if?: string; permissions?: Record<string, string>; steps: Step[] }>;
};
const agentSteps = compiled.jobs.agent.steps;

describe('Cloud Hypervisor Copilot agent enclave smoke', () => {
  it('includes main in source builds only when explicitly requested by the agent smoke', () => {
    const scriptBuild = buildBranchEnclaveInstallSteps('      ');
    const agentBuild = buildBranchEnclaveInstallSteps('      ', true);
    expect(scriptBuild).toContain("github.ref != 'refs/heads/main'");
    expect(agentBuild).not.toContain("github.ref != 'refs/heads/main'");
    for (const build of [scriptBuild, agentBuild]) {
      expect(build).toContain("github.event_name == 'workflow_dispatch'");
      expect(build).toContain("github.repository == 'github/gh-aw-firewall'");
      expect(build).toContain("github.ref_type == 'branch'");
      expect(build).toContain('--build-local');
    }
  });

  it('is a separate manual-only public-fixture test with no GitHub tools or script executor', () => {
    expect(frontmatter.on).toEqual({ workflow_dispatch: null });
    expect(frontmatter.if)
      .toBe("github.repository == 'github/gh-aw-firewall' && github.ref_type == 'branch'");
    expect(frontmatter['runs-on']).toBe('ubuntu-24.04');
    expect(frontmatter.features).toEqual({ 'cloud-hypervisor-agent-acceptance': true });
    expect(frontmatter.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    expect(frontmatter.tools).toEqual({ github: false });
    expect(frontmatter.engine.args).toEqual(['--allow-tool', 'awf-enclave(enclave_run_agent)']);
    expect(frontmatter.engine.env.GH_AW_HARNESS_STARTUP_RETRIES).toBe('0');
    expect(frontmatter.engine.env.GH_AW_HARNESS_MAX_RETRIES).toBe('0');
    expect(source).toContain('awf-enclave enclave_run_agent .');
    expect(source).toContain('/awf/seed/package.json');
    expect(source).not.toContain('enclave_run_script');
    for (const job of Object.values(compiled.jobs)) {
      expect(job.permissions?.issues).not.toBe('write');
      expect(job.permissions?.['pull-requests']).not.toBe('write');
    }
    expect(compiled.jobs.activation.if).toBe(frontmatter.if);
  });

  it('selects Cloud Hypervisor for both the primary and the Copilot agent enclave', () => {
    const enclave = {
      agent: {
        engine: 'copilot', model: 'claude-sonnet-5',
        'max-task-bytes': 4096, 'max-model-requests': 8, 'max-model-tokens': 2048,
      },
      runtime: 'cloud-hypervisor',
      repos: [{ repo: 'github/gh-aw-firewall', sensitivity: 'public' }],
      timeout: 90, 'max-output-bytes': 256, 'max-invocations': 1,
    };
    expect(frontmatter.enclaves).toEqual([enclave]);
    expect(frontmatter.sandbox.agent).toEqual({
      id: 'awf', version: 'v0.28.64', runtime: 'cloud-hypervisor',
      config: { filesystem: { 'allow-write': ['/tmp/gh-aw/aw_info.json'] } },
    });
    expect(CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG).toBe(frontmatter.sandbox.agent.version);
    const match = lock.match(/\\"enclaves\\":(\[.+?\]),\\"container\\"/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1].replace(/\\"/g, '"'))).toEqual([{
      agent: {
        engine: 'copilot', model: 'claude-sonnet-5',
        maxTaskBytes: 4096, maxModelRequests: 8, maxModelTokens: 2048,
      },
      runtime: 'cloud-hypervisor', repos: enclave.repos,
      timeout: 90, maxOutputBytes: 256, maxInvocations: 1,
    }]);
    expect(lock).toContain('--container-runtime cloud-hypervisor');
    expect(lock).not.toContain('--container-runtime docker');
    expect(lock).not.toContain('\\"containerRuntime\\":\\"docker\\"');
    expect(lock).toContain('--cloud-hypervisor-preview');
    const writes = lock.match(/\\"filesystem\\":\{\\"allowWrite\\":(\[.*?\])\}/);
    expect(writes).not.toBeNull();
    expect(JSON.parse(writes![1].replace(/\\"/g, '"'))).toEqual([
      '/tmp/gh-aw/aw_info.json', '/tmp/gh-aw/agent',
      '/tmp/gh-aw/sandbox/agent/logs', '/workspace', '/workspace/.awf-home',
    ]);
    expect(lock).toContain('COPILOT_GITHUB_TOKEN: ${{ github.token }}');
    expect(lock).toContain('--exclude-env COPILOT_GITHUB_TOKEN');
    expect(lock).toContain('--exclude-env GH_TOKEN');
    expect(lock).toContain('--exclude-env MCP_GATEWAY_API_KEY');
    expect(lock).toContain('export GH_AW_MCP_DEFERRED_SERVERS="awf-enclave"');
    expect(lock).not.toContain('"github": {');
    const entries: RawEnclavesConfig = JSON.parse(match![1].replace(/\\"/g, '"'));
    const normalized = normalizeEnclavesConfig(entries, { primaryRuntime: 'cloud-hypervisor' });
    expect(normalized?.executors.agent.enabled).toBe(true);
    expect(normalized?.executors.agent.runtime).toBe('cloud-hypervisor');
    expect(normalized?.executors.script.enabled).toBe(false);
    const original = process.env;
    try {
      const sha = 'a'.repeat(40);
      process.env = {
        ...original,
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'github/gh-aw-firewall',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF_TYPE: 'branch',
        GITHUB_REF_NAME: 'test-agent-enclave',
        GITHUB_REF: 'refs/heads/test-agent-enclave',
        GITHUB_SHA: sha,
        GITHUB_WORKFLOW_SHA: sha,
        GITHUB_WORKFLOW_REF: 'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor-copilot.lock.yml@refs/heads/test-agent-enclave',
      };
      const imageTag = lock.match(/\\"imageTag\\":\\"([^"]+)\\"/);
      expect(imageTag).not.toBeNull();
      const acceptanceConfig = {
        containerRuntime: 'cloud-hypervisor',
        imageTag: imageTag![1],
        enclaves: normalized,
        cloudHypervisor: {
          previewEnabled: true,
          mountPolicy: 'workspace-and-tool-cache',
          artifactReleaseTag: 'v0.28.64',
          cloudHypervisorBinary: '/usr/local/bin/cloud-hypervisor',
          vcpuCount: 2,
          memoryMib: 512,
          apiTimeoutMs: 5000,
        },
      } satisfies Parameters<typeof isCloudHypervisorAgentAcceptanceWorkflow>[0];
      expect(isCloudHypervisorAgentAcceptanceWorkflow(acceptanceConfig)).toBe(true);
      expect(isCloudHypervisorAgentAcceptanceWorkflow({
        ...acceptanceConfig,
        cloudHypervisor: { ...acceptanceConfig.cloudHypervisor, artifactReleaseTag: 'v0.28.62' },
      })).toBe(false);
      expect(source).toContain('host acceptance gate now selects only v0.28.64');
    } finally {
      process.env = original;
    }
    expect(() => normalizeEnclavesConfig(entries, { primaryRuntime: 'docker' }))
      .toThrow(/differs from primary backend/);
    expect(source).toContain('settings are **advisory only**');
  });

  it('uses the exact static agent tool request contract', () => {
    const match = source.match(/awf-enclave enclave_run_agent \. <<'JSON'\n([\s\S]*?)\nJSON/);
    expect(match).not.toBeNull();
    const request = JSON.parse(match![1]) as {
      privateRepo: string; schema: unknown; prompt: string;
    };
    expect(Object.keys(request).sort()).toEqual(['privateRepo', 'prompt', 'schema']);
    expect(request.privateRepo).toBe('github/gh-aw-firewall');
    expect(request.schema).toEqual({
      type: 'object',
      fields: { package_json: { type: 'boolean' }, src: { type: 'boolean' } },
    });
    expect(request.prompt).toContain('/awf/seed/package.json');
    expect(Buffer.byteLength(request.prompt, 'utf8')).toBeLessThanOrEqual(4096);
  });

  it('identifies the compiler backport and preserves CLI and immutable release pins', () => {
    expect(frontmatter.engine.version).toBe('1.0.96');
    expect(lock).toContain('"compiler_version":"dev-v0.92.3-enclave-agent-acceptance.c483bd2e10ac"');
    expect(lock).toContain('github/gh-aw-actions/setup@26e5d7e7d2345ae4c8dfa3d9017ca2ff9bbf2c82');
    expect(lock).toContain('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1');
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.33@sha256:2b278f891b4566d27494658b37f628810f93da4caf510e266892ca344e55f8e0');
    const digest = 'sha256:f691024f84f14d2720185ed21ebebcbc11b10e943df5c54080e14733ec3121c3';
    expect(lock).toContain(`ghcr.io/github/gh-aw-firewall/enclave-agent:0.28.64@${digest}`);
    expect(lock).not.toContain('resolution_failures');
    expect(agentSteps.find(step => step.name === 'Download and verify cloud-hypervisor enclave artifacts')?.run)
      .toContain('cloud_hypervisor_setup_enclave_artifacts.sh');
    expect(lock).not.toContain('--cloud-hypervisor-allow-unsafe');
    expect(lock).not.toContain('build-test-artifacts.sh');
    expect(lock).not.toContain('AWF_CLOUD_HYPERVISOR_ALLOW_UNATTESTED');
  });

  it('retains branch-only source builds, public debug protections and postprocessor idempotency', () => {
    expect(usesPublishedAwfRelease(workflowPath)).toBe(true);
    const install = agentSteps.find(step => step.name === 'Install awf binary (local)');
    expect(install?.if).toContain("github.repository == 'github/gh-aw-firewall'");
    expect(install?.if).toContain("github.ref_type == 'branch'");
    expect(install?.if).not.toContain("github.ref != 'refs/heads/main'");
    expect(install?.run).toContain('--build-local');
    expect(install?.run).toContain('"\\$arg" = "--skip-pull"');
    expect(lock).toContain('sudo --preserve-env awf --cloud-hypervisor-enclave-debug-public --config ');
    const upload = agentSteps.find(step => step.name === 'Upload public enclave debug evidence');
    expect(upload?.if).toContain("steps.collect-enclave-debug.outcome == 'success'");
    expect(upload?.with?.['retention-days']).toBe(1);
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(applyGeneralWorkflowPatches(lock, workflowPath).content).toBe(lock);
  });

  it('builds an explicitly unattested enclave-only supervisor on the exact PR branch', () => {
    const setup = agentSteps.find(step => step.name === 'Setup Go for development enclave supervisor');
    const build = agentSteps.find(step => step.name === 'Build UNATTESTED development enclave supervisor');
    expect(setup?.uses).toBe('actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e');
    expect(setup?.with).toEqual({ 'go-version': '1.25.0', cache: false });
    for (const step of [setup, build]) {
      expect(step?.if).toContain("github.ref == 'refs/heads/lpcox-smoke-pins-v0-28-64'");
      expect(step?.if).toContain("github.event_name == 'workflow_dispatch'");
      expect(step?.if).toContain("github.repository == 'github/gh-aw-firewall'");
    }
    expect(build?.run).toContain('GOTOOLCHAIN=local go test ./...');
    expect(build?.run).toContain('VERSION="development-${GITHUB_SHA}"');
    expect(build?.run).toContain('sudo install -m 0555 -o root -g root');
    expect(build?.run).toContain('AWF_CH_ENCLAVE_TEST_SUPERVISOR_SHA256');
    expect(build?.run).toContain('UNATTESTED DEVELOPMENT enclave supervisor');
    expect(lock).not.toContain('--cloud-hypervisor-development-allow-unattested-artifacts');
    expect(source).toContain('unattested development supervisor');
  });

  it('only publishes a fixed summary after successful host validation', () => {
    const job = compiled.jobs.report_smoke_result;
    expect(job.if).toContain("needs.agent.result == 'success'");
    const report = job.steps.find(step => step.name === 'Record enclave result');
    expect(report?.run).toContain('ENCLAVE_COPILOT_PASS {"package_json":true,"src":true}');
    expect(report?.run).not.toContain('inputs.result');
    expect(agentSteps.find(step => step.name === 'Validate enclave invocation and result')?.if)
      .toBe('always()');
  });

  it('executes the generated validator against success and contradictory failure evidence', () => {
    const step = agentSteps.find(value => value.name === 'Validate enclave invocation and result');
    const sourceStep = frontmatter['post-steps'].find(value => value.name === step?.name);
    expect(step?.run?.trim()).toBe(sourceStep?.run?.trim());
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-enclave-validation-'));
    const auditPath = path.join(temp, 'audit.jsonl');
    const outputsPath = path.join(temp, 'outputs.jsonl');
    const invocation = { kind: 'invocation', repo: 'github/gh-aw-firewall', sensitivity: 'public' };
    const result = {
      type: 'report_smoke_result',
      result: 'ENCLAVE_COPILOT_PASS {"package_json":true,"src":true}',
    };
    const validate = (audit: unknown[], outputs: unknown[]) => {
      fs.writeFileSync(auditPath, audit.map(record => JSON.stringify(record)).join('\n'));
      fs.writeFileSync(outputsPath, outputs.map(record => JSON.stringify(record)).join('\n'));
      return execFileSync('bash', ['-c', step!.run!], {
        env: { ...process.env, AUDIT_LOG: auditPath, OUTPUTS_FILE: outputsPath },
        stdio: 'pipe',
      });
    };
    try {
      expect(() => validate([invocation], [result])).not.toThrow();
      for (const audit of [[], [invocation, invocation],
        [{ ...invocation, repo: 'other/repo' }], [{ ...invocation, sensitivity: 'private' }],
        [invocation, { kind: 'failure' }]]) {
        expect(() => validate(audit, [result])).toThrow();
      }
      for (const outputs of [[], [result, result], [{ ...result, result: 'false result' }],
        [result, { type: 'missing_tool' }], [result, { type: 'missing_data' }],
        [result, { type: 'noop' }], [result, { type: 'report_incomplete' }]]) {
        expect(() => validate([invocation], outputs)).toThrow();
      }
      fs.writeFileSync(auditPath, 'not JSON');
      expect(() => execFileSync('bash', ['-c', step!.run!], {
        env: { ...process.env, AUDIT_LOG: auditPath, OUTPUTS_FILE: outputsPath },
        stdio: 'pipe',
      })).toThrow();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
