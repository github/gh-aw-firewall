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
  needs?: string;
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
        acceptance_commit: { type: string; default: string };
      };
    };
    pull_request: { types: string[]; paths: string[] };
  };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const source = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(source) as Workflow;

describe('Cloud Hypervisor enclave conformance CI boundary', () => {
  it('runs deterministic conformance without privileged probes or KVM artifacts', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['deterministic', 'host-probes', 'live-kvm']);
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
  });

  it('opts live broker-to-VM acceptance in separately and never substitutes development artifacts', () => {
    expect(workflow.on.workflow_dispatch.inputs.run_live_kvm).toMatchObject({
      type: 'boolean', default: false,
    });
    const job = workflow.jobs['live-kvm'];
    expect(job.needs).toBe('deterministic');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.run_live_kvm");
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
    expect(gate.run).toContain('cloud-hypervisor-enclave-release-gate.js');
    expect(gate.run).toContain('gh release view "$tag"');
    expect(gate.env).toMatchObject({ AWF_ACCEPTANCE_COMMIT: '${{ inputs.acceptance_commit }}' });
    const secretSteps = job.steps.filter((step) => JSON.stringify(step).includes('secrets.COPILOT_GITHUB_TOKEN'));
    expect(secretSteps).toHaveLength(1);
    expect(job.steps.indexOf(secretSteps[0])).toBeGreaterThan(gateIndex);
    expect(secretSteps[0].run).toContain('GITHUB_REF');
    expect(secretSteps[0].run).toContain('AWF_ACCEPTANCE_COMMIT');
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
      for (const step of job.steps) {
        expect(step['continue-on-error']).toBeUndefined();
        if (step.uses) {
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
          expect(step.uses).not.toContain('upload-artifact');
        }
        if (step.run) {
          expect(step.run).not.toMatch(/\|\| true|exit 0/);
          expect(() => execFileSync('bash', ['-n'], { input: step.run })).not.toThrow();
        }
      }
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
      '.github/workflows/test-cloud-hypervisor-enclaves.yml',
    ]));
  });
});
