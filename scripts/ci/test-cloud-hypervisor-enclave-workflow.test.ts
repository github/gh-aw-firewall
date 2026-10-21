import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/test-cloud-hypervisor-enclaves.yml');
interface Step {
  name: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
  with?: Record<string, unknown>;
}
interface Job {
  'runs-on': string;
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  steps: Step[];
  'continue-on-error'?: boolean;
}
interface Workflow {
  on: {
    workflow_dispatch: {
      inputs: {
        run_host_probes: { type: string; default: boolean };
        run_live_kvm: { type: string; default: boolean };
        run_environment_probe: { type: string; default: boolean };
        acceptance_commit: { type: string; default: string };
        artifact_mode: { type: string; default: string; options: string[] };
      };
    };
    pull_request: { types: string[]; paths: string[] };
  };
  permissions: Record<string, string>;
  jobs: {
    deterministic: Job;
    'host-probes': Job;
    'live-kvm': Job;
    'environment-probe': Job;
    'candidate-artifacts': {
      needs: string;
      if: string;
      uses: string;
      with: Record<string, unknown>;
      permissions: Record<string, string>;
      secrets?: unknown;
      'continue-on-error'?: boolean;
    };
  };
}

const source = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(source) as Workflow;

describe('Cloud Hypervisor enclave conformance CI boundary', () => {
  it.each(['live-kvm', 'environment-probe'] as const)('preserves real admission identity across sudo in %s', jobName => {
    const command = workflow.jobs[jobName].steps.find(step =>
      step.run?.includes('--preserve-env=') && step.run.includes('node scripts/ci/'))!.run!;
    const preserved = command.match(/--preserve-env=([^\s]+)/)![1].split(',');
    expect(preserved).toEqual(expect.arrayContaining([
      'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME',
      'GITHUB_REF', 'GITHUB_REF_TYPE', 'GITHUB_REF_NAME', 'GITHUB_SHA',
      'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'AWF_ACCEPTANCE_COMMIT',
      'AWF_ENCLAVE_ACCEPTANCE_MODE', 'AWF_CLOUD_HYPERVISOR_CANDIDATE_ARTIFACTS',
    ]));
    expect(preserved).not.toContain('GITHUB_*');
  });

  it('runs deterministic conformance without privileged probes or KVM artifacts', () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      'deterministic', 'candidate-artifacts', 'host-probes', 'live-kvm', 'environment-probe',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.deterministic;
    expect(job.if).toBeUndefined();
    expect(job.steps.some((step) => step.uses?.startsWith('actions/setup-go@'))).toBe(true);
    expect(job.env).toEqual({ AWF_TEST_ENCLAVE_STORAGE: '0', AWF_TEST_ENCLAVE_NETWORK: '0' });
    const command = job.steps.find((step) => step.name === 'Run deterministic enclave conformance')!.run!;
    expect(command).toContain('--runTestsByPath');
    const selectors = command.match(/[\w/-]+\.test\.ts/g)!;
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) expect(fs.existsSync(path.join(root, selector))).toBe(true);
    expect(selectors).toEqual(expect.arrayContaining([
      'src/enclave/host-executor-broker.test.ts',
      'src/enclave/host-executor-protocol.test.ts',
      'src/enclave/cloud-hypervisor-lifecycle.test.ts',
      'src/cloud-hypervisor/host-enclave-executor.test.ts',
      'src/cloud-hypervisor/enclave-storage.test.ts',
      'src/cloud-hypervisor/trusted-enclave-storage.test.ts',
      'src/cloud-hypervisor/trusted-enclave-preflight.test.ts',
      'src/cloud-hypervisor/workload-profile.test.ts',
      'src/enclave/gateway.test.ts',
      'scripts/ci/cloud-hypervisor-enclave-gateway.test.ts',
      'src/enclave/workflow-integration.test.ts',
      'src/commands/main-action-startup-diagnostics.test.ts',
      'src/cli-workflow.test.ts',
      'src/enclave/startup-progress.test.ts',
      'src/cloud-hypervisor/host-preflight-progress.test.ts',
      'src/cloud-hypervisor/mount-topology.test.ts',
      'src/cloud-hypervisor/artifact-trust.test.ts',
      'src/cloud-hypervisor/artifact-snapshot.test.ts',
      'src/enclave/host-executor-journal.test.ts',
      'src/cloud-hypervisor/cleanup-process.test.ts',
      'src/cloud-hypervisor/preflight.test.ts',
      'scripts/ci/cloud-hypervisor-enclave-host-preflight.test.ts',
      'scripts/ci/cloud-hypervisor-enclave-environment-probe.test.ts',
      'scripts/ci/cloud-hypervisor-environment-probe.test.ts',
    ]));
    const commands = job.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/sudo|unshare|AWF_REQUIRE_LIVE_GUEST_PROBE|\.integration\.test\.ts/);
  });

  it('opts privileged probes in explicitly and rejects unsupported hosts before probing', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.run_host_probes).toMatchObject({
      type: 'boolean', default: false,
    });
    expect(workflow.on.pull_request.types).toContain('labeled');
    const job = workflow.jobs['host-probes'];
    expect(job.needs).toBe('deterministic');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.if?.replace(/\s+/g, ' ').trim()).toBe(
      "(github.event_name == 'workflow_dispatch' && inputs.run_host_probes) || " +
      "(github.event_name == 'pull_request' && " +
      "contains(github.event.pull_request.labels.*.name, 'cloud-hypervisor-enclave-conformance'))",
    );
    const gateIndex = job.steps.findIndex((step) => step.name.startsWith('Require eligible'));
    const gate = job.steps[gateIndex].run!;
    expect(gate).toContain('assertGithubHostedRunnerEligibility()');
    expect(gate).toContain('isCharacterDevice()');
    expect(gate).toContain('fs.openSync("/dev/kvm", "r+")');
    expect(gate).toContain('/sys/fs/cgroup/cgroup.controllers');
    for (const flag of ['AWF_TEST_ENCLAVE_STORAGE=1', 'AWF_TEST_ENCLAVE_NETWORK=1', 'AWF_REQUIRE_LIVE_GUEST_PROBE=1']) {
      const index = job.steps.findIndex((step) => step.run?.includes(flag));
      expect(index).toBeGreaterThan(gateIndex);
    }
    expect(job.steps.find((step) => step.name.startsWith('Probe real'))!.run)
      .toContain('unshare --mount --propagation private');
    expect(job.steps.find((step) => step.name.startsWith('Probe real'))!.run)
      .toContain('src/cloud-hypervisor/enclave-trusted-storage.integration.test.ts');
    expect(job.steps.find((step) => step.name === 'Remove probe executable')?.if).toBe('always()');
    const admission = job.steps.find((step) => step.name.startsWith('Probe production host admission'))!;
    expect(admission.run).toContain('sudo -n --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS');
    expect(admission.run).toContain('env "PATH=$PATH" "$(command -v node)"');
    expect(admission.run?.match(/--preserve-env=([^\s]+)/)?.[1].split(',')).toEqual([
      'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'ImageOS',
    ]);
    expect(admission.run).toContain('cloud-hypervisor-enclave-host-preflight.js');
    expect(job.steps.indexOf(admission)).toBeGreaterThan(gateIndex);
    expect(admission['continue-on-error']).toBeUndefined();
    const capture = job.steps.find((step) => step.name.startsWith('Probe mount capture hypotheses'))!;
    expect(job.steps.indexOf(capture)).toBeGreaterThan(gateIndex);
    expect(job.steps.indexOf(capture)).toBeLessThan(job.steps.findIndex((step) => step.name.startsWith('Probe real')));
    expect(capture.run).toContain('unshare --mount --propagation private');
    expect(capture.run).toContain('AWF_TEST_ENCLAVE_STORAGE=1');
    expect(capture.run).toContain('src/cloud-hypervisor/enclave-mount-capture.integration.test.ts');
    expect(capture['continue-on-error']).toBeUndefined();
  });

  it('opts live broker-to-VM acceptance in separately and never substitutes development artifacts', () => {
    expect(workflow.on.workflow_dispatch.inputs.run_live_kvm).toMatchObject({
      type: 'boolean', default: false,
    });
    const job = workflow.jobs['live-kvm'];
    expect(job.needs).toEqual(['deterministic', 'candidate-artifacts']);
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain('inputs.run_live_kvm');
    expect(job.if).toContain("needs.deterministic.result == 'success'");
    const harness = job.steps.find((step) => step.name.startsWith('Run release-attested'))!;
    expect(harness.run).toContain('cloud-hypervisor-enclave-live-smoke.js');
    expect(harness.env).toMatchObject({
      COPILOT_GITHUB_TOKEN: '${{ secrets.COPILOT_GITHUB_TOKEN }}',
    });
    expect(job.steps.some((step) => step.run?.includes('AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS')))
      .toBe(false);
    expect(job.steps.some((step) => step.uses?.includes('upload-artifact'))).toBe(false);
    const cleanup = job.steps.find((step) => step.name.startsWith('Remove only this job'))!;
    expect(cleanup.run).toContain('com.github.gh-aw.mcpg.run');
    expect(cleanup.run).toContain('GITHUB_RUN_ATTEMPT');
  });

  it('requires exact release source and reviewed ancestry before introducing the Copilot secret', () => {
    expect(workflow.on.workflow_dispatch.inputs.acceptance_commit).toEqual(expect.objectContaining({
      type: 'string', default: '',
    }));
    const job = workflow.jobs['live-kvm'];
    expect(job.steps[0].with).toMatchObject({ 'fetch-depth': 0, 'fetch-tags': true });
    const gateIndex = job.steps.findIndex((step) => step.name.startsWith('Require exact published'));
    const gate = job.steps[gateIndex];
    expect(gate.if).toBe("inputs.artifact_mode != 'candidate'");
    expect(gate.run).toContain('cloud-hypervisor-enclave-release-gate.js');
    expect(gate.run).toContain('gh release view "$tag"');
    expect(gate.env).toMatchObject({ AWF_ACCEPTANCE_COMMIT: '${{ inputs.acceptance_commit }}' });
    const secretSteps = job.steps.filter((step) => JSON.stringify(step).includes('secrets.COPILOT_GITHUB_TOKEN'));
    expect(secretSteps).toHaveLength(1);
    expect(job.steps.indexOf(secretSteps[0])).toBeGreaterThan(gateIndex);
    expect(secretSteps[0].run).toContain('GITHUB_REF');
    expect(secretSteps[0].run).toContain('AWF_ACCEPTANCE_COMMIT');
  });

  it('runs the script-only environment probe in a distinct opt-in job without the Copilot secret', () => {
    expect(workflow.on.workflow_dispatch.inputs.run_environment_probe).toMatchObject({
      type: 'boolean', default: false,
    });
    const job = workflow.jobs['environment-probe'];
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain('inputs.run_environment_probe');
    expect(job.needs).toBe('candidate-artifacts');
    expect(job.if).not.toContain('needs.deterministic');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.steps[0].with).toMatchObject({ 'fetch-depth': 0, 'fetch-tags': true });
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|COPILOT_GITHUB_TOKEN|enable-api-proxy/);
    const names = job.steps.map((step) => step.name);
    const gateIndex = names.findIndex((name) => name.startsWith('Require exact published'));
    const hostIndex = names.findIndex((name) => name.startsWith('Verify GitHub-hosted'));
    const probeIndex = names.findIndex((name) => name.startsWith('Run the public environment probe'));
    expect(gateIndex).toBeGreaterThan(0);
    expect(hostIndex).toBeGreaterThan(gateIndex);
    expect(probeIndex).toBeGreaterThan(hostIndex);
    const gate = job.steps[gateIndex];
    expect(gate.if).toBe("inputs.artifact_mode != 'candidate'");
    expect(gate.run).toContain('cloud-hypervisor-enclave-release-gate.js --environment-probe');
    expect(gate.run).toContain('gh release view "$tag"');
    expect(gate.env).toMatchObject({ AWF_ACCEPTANCE_COMMIT: '${{ inputs.acceptance_commit }}' });
    const host = job.steps[hostIndex].run!;
    expect(host).toContain('assertGithubHostedRunnerEligibility()');
    expect(host).toContain('fs.openSync("/dev/kvm", "r+")');
    expect(host).toContain('/sys/fs/cgroup/cgroup.controllers');
    const probe = job.steps[probeIndex];
    expect(probe.run).toContain('node scripts/ci/cloud-hypervisor-enclave-environment-probe.js');
    expect(probe.run).toContain('GITHUB_REF');
    expect(probe.run).toContain('AWF_ACCEPTANCE_COMMIT');
    expect(probe.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      GITHUB_TOKEN: '${{ github.token }}',
      AWF_ACCEPTANCE_COMMIT: '${{ inputs.acceptance_commit }}',
      AWF_CLOUD_HYPERVISOR_CANDIDATE_ARTIFACTS: '${{ runner.temp }}/cloud-hypervisor-test-x86_64',
    });
    expect(job.steps.some((step) => /probe\.py\b(?!.*unittest)/.test(step.run ?? ''))).toBe(false);
    const cleanup = job.steps.find((step) => step.name.startsWith('Remove only this job'))!;
    expect(cleanup.if).toBe('always()');
    expect(cleanup.run).toContain('-enclave-probe"');
  });

  it('keeps privileged enclave probes out of the ordinary artifact build job', () => {
    const primary = yaml.load(fs.readFileSync(
      path.join(root, '.github/workflows/test-cloud-hypervisor.yml'), 'utf8',
    )) as { jobs: Record<string, Job> };
    const commands = primary.jobs['build-test-artifacts'].steps.map((step) => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/AWF_TEST_ENCLAVE_STORAGE|AWF_REQUIRE_LIVE_GUEST_PROBE/);
  });

  it('does not grant artifact bypasses, upload guest output, or mask probe failures', () => {
    expect(source).not.toMatch(/allow.unattested|DEVELOPMENT_ALLOW|continue-on-error|chmod 666|setfacl/);
    for (const job of Object.values(workflow.jobs)) {
      expect(job['continue-on-error']).toBeUndefined();
      if (!('steps' in job)) {
        expect(job.uses).toBe('./.github/workflows/test-cloud-hypervisor.yml');
        continue;
      }
      for (const step of job.steps) {
        expect(step['continue-on-error']).toBeUndefined();
        if (step.uses) {
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          expect(step.uses).not.toContain('upload-artifact');
          if (step.uses.startsWith('actions/checkout@')) {
            expect(step.with).toMatchObject({ 'persist-credentials': false });
          }
        }
        if (step.run) {
          expect(step.run).not.toMatch(/\|\| true|exit 0/);
          expect(() => execFileSync('bash', ['-n'], { input: step.run })).not.toThrow();
        }
      }
    }
  });

  it('separates same-commit candidate artifacts from the default published-release path', () => {
    expect(workflow.on.workflow_dispatch.inputs.artifact_mode).toMatchObject({
      type: 'choice', default: 'release', options: ['release', 'candidate'],
    });
    const builder = workflow.jobs['candidate-artifacts'];
    expect(builder.needs).toBe('deterministic');
    expect(builder.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(builder.if).toContain("inputs.artifact_mode == 'candidate'");
    expect(builder.with).toEqual({
      candidate_build: true, run_live_kvm: false,
      candidate_commit: '${{ inputs.acceptance_commit }}',
    });
    expect(builder.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' });
    expect(builder.secrets).toBeUndefined();
    for (const name of ['live-kvm', 'environment-probe'] as const) {
      const job = workflow.jobs[name];
      expect(job.if).toContain('always() && !cancelled()');
      expect(job.if).toContain("needs.candidate-artifacts.result == 'success'");
      expect(job.if).toContain("needs.candidate-artifacts.result == 'skipped'");
      const download = job.steps.find(step => step.name === 'Download same-run candidate artifacts')!;
      expect(download.if).toBe("inputs.artifact_mode == 'candidate'");
      expect(download.with).toEqual({
        name: 'cloud-hypervisor-test-x86_64',
        path: '${{ runner.temp }}/cloud-hypervisor-test-x86_64',
      });
      const build = job.steps.find(step => step.name === 'Build candidate-only host compatibility profile')!;
      expect(build.if).toBe("inputs.artifact_mode == 'candidate'");
      expect(build.run).toContain('cloud-hypervisor-enclave-candidate.js configure');
      expect(build.run).toContain('chmod 0755');
      const verifyIndex = job.steps.findIndex(step => step.name === 'Require exact reviewed candidate source');
      expect(job.steps[verifyIndex].if).toBe("inputs.artifact_mode == 'candidate'");
      const executionIndex = job.steps.findIndex(step => step.run?.includes('--preserve-env=PATH'));
      expect(verifyIndex).toBeLessThan(executionIndex);
    }
  });

  it('triggers for public broker, runtime, storage, and its own harness changes', () => {
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
      'src/enclave/**', 'src/cloud-hypervisor/**', 'src/microvm/**',
      'containers/enclave/**', 'guest/microvm-supervisor/**',
      'scripts/ci/*cloud-hypervisor*.test.ts',
      'scripts/ci/cloud-hypervisor-enclave-live-smoke.js',
      'scripts/ci/cloud-hypervisor-enclave-release-gate.js',
      'scripts/ci/cloud-hypervisor-enclave-startup-faults.js',
      'scripts/ci/cloud-hypervisor-enclave-gateway*',
      'scripts/ci/cloud-hypervisor-enclave-environment-probe.js',
      'examples/enclave-environment-probe/**',
      '.github/workflows/test-cloud-hypervisor-enclaves.yml',
    ]));
  });
});
