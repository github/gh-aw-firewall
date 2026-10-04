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
  'continue-on-error'?: boolean;
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
    workflow_dispatch: { inputs: { run_host_probes: { type: string; default: boolean } } };
    pull_request: { types: string[]; paths: string[] };
  };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const source = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(source) as Workflow;

describe('Cloud Hypervisor enclave conformance CI boundary', () => {
  it('runs deterministic conformance without privileged probes or KVM artifacts', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['deterministic', 'host-probes']);
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
      '.github/workflows/test-cloud-hypervisor-enclaves.yml',
    ]));
  });
});
