import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';

const workflowPath = path.resolve(__dirname, '../../.github/workflows/test-cloud-hypervisor.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface WorkflowDoc {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, WorkflowJob>;
}

function loadWorkflow(): WorkflowDoc {
  return yaml.load(fs.readFileSync(workflowPath, 'utf-8')) as WorkflowDoc;
}

describe('Cloud Hypervisor CI workflow', () => {
  it('parses as valid YAML with the expected jobs', () => {
    const doc = loadWorkflow();
    expect(Object.keys(doc.jobs)).toEqual(['build-test-artifacts', 'live-kvm']);
  });

  it('grants only the minimal permissions the workflow needs', () => {
    const doc = loadWorkflow();
    expect(doc.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
  });

  it('uses a non-cancelling concurrency group scoped to the ref', () => {
    const doc = loadWorkflow();
    expect(doc.concurrency.group).toBe('cloud-hypervisor-preview-${{ github.ref }}');
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
  });

  it('triggers only on workflow_dispatch and pull_request, scoped to relevant paths', () => {
    const doc = loadWorkflow();
    expect(Object.keys(doc.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    const pullRequest = doc.on.pull_request as { types: string[]; paths: string[] };
    expect(pullRequest.types).toEqual(['opened', 'synchronize', 'reopened', 'labeled']);
    expect(pullRequest.paths).toEqual(
      expect.arrayContaining([
        'guest/cloud-hypervisor/**',
        'containers/build-tools/**',
        'src/cloud-hypervisor/**',
        'scripts/ci/cloud-hypervisor-*.sh',
      ]),
    );
    const workflowDispatch = doc.on.workflow_dispatch as {
      inputs: { run_live_kvm: { type: string; default: boolean } };
    };
    expect(workflowDispatch.inputs.run_live_kvm.type).toBe('boolean');
    expect(workflowDispatch.inputs.run_live_kvm.default).toBe(true);
  });

  it('gates the live-kvm job on manual dispatch or an explicit label, never push/schedule', () => {
    const doc = loadWorkflow();
    const liveKvm = doc.jobs['live-kvm'];
    expect(liveKvm.if).toContain('cloud-hypervisor-kvm');
    expect(liveKvm.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(liveKvm.needs).toBe('build-test-artifacts');
  });

  it('builds and verifies pinned guest artifacts before attesting provenance', () => {
    const doc = loadWorkflow();
    const build = doc.jobs['build-test-artifacts'];
    const runSteps = (build.steps ?? []).map((step) => step.run).filter(Boolean) as string[];
    expect(runSteps.some((run) => run.includes('./guest/cloud-hypervisor/build-test-artifacts.sh'))).toBe(true);
    expect(runSteps.some((run) => run.includes('docker build') && run.includes('containers/build-tools'))).toBe(true);
    expect(runSteps.some((run) => run.includes('BUILD_TOOLS_IMAGE=awf-cloud-hypervisor-build-tools:test'))).toBe(true);
    expect(runSteps.some((run) => run.includes('./guest/cloud-hypervisor/verify-test-artifacts.sh'))).toBe(true);
    const usesSteps = (build.steps ?? []).map((step) => step.uses).filter(Boolean) as string[];
    expect(usesSteps.some((uses) => uses.startsWith('actions/attest-build-provenance@'))).toBe(true);
    expect(usesSteps.some((uses) => uses.startsWith('actions/upload-artifact@'))).toBe(true);
  });

  it('restores executable permissions lost by the artifact upload/download round-trip before preflight', () => {
    // Regression test: actions/upload-artifact + actions/download-artifact do
    // not reliably preserve the executable bit on binary files, even though
    // guest/cloud-hypervisor/build-test-artifacts.sh chmods the binary to
    // 0755 before archiving and verify-test-artifacts.sh confirms it is
    // executable in the same job, pre-upload. Discovered via a live
    // workflow_dispatch run: "Permission denied" executing the downloaded
    // cloud-hypervisor binary despite a correct, digest-verified artifact.
    const doc = loadWorkflow();
    const live = doc.jobs['live-kvm'];
    const steps = live.steps ?? [];
    const downloadIndex = steps.findIndex((step) =>
      (step.uses ?? '').startsWith('actions/download-artifact@'));
    const restoreIndex = steps.findIndex((step) =>
      step.name === 'Restore artifact executable permissions');
    const preflightIndex = steps.findIndex((step) =>
      (step.run ?? '').includes('cloud-hypervisor-host-preflight.sh'));

    expect(downloadIndex).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(downloadIndex);
    expect(preflightIndex).toBeGreaterThan(restoreIndex);

    const restoreStep = steps[restoreIndex];
    expect(restoreStep.run).toContain('chmod 0755');
    expect(restoreStep.run).toContain('cloud-hypervisor-test-x86_64/cloud-hypervisor');
    expect(restoreStep.run).toContain('cloud-hypervisor-test-x86_64/awf-supervisor');
  });

  it('verifies digests before running the live suite and cleans up unconditionally', () => {
    const doc = loadWorkflow();
    const live = doc.jobs['live-kvm'];
    const steps = live.steps ?? [];
    const preflightIndex = steps.findIndex((step) =>
      (step.run ?? '').includes('cloud-hypervisor-host-preflight.sh'));
    const smokeIndex = steps.findIndex((step) =>
      (step.run ?? '').includes('cloud-hypervisor-live-smoke.sh'));
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(preflightIndex);

    const cleanupStep = steps.find((step) => step.name === 'Enforce final residue cleanup');
    expect(cleanupStep?.if).toBe('always()');
    expect(cleanupStep?.run).toContain('awffc-');
    expect(cleanupStep?.run).toContain('awf-cloud-hypervisor');

    const diagnosticsStep = steps.find((step) => step.name === 'Collect redacted diagnostics');
    expect(diagnosticsStep?.if).toBe('always()');
    expect(diagnosticsStep?.run).toContain('awf-cloud-hypervisor-real-secret-do-not-expose');

    const uploadStep = steps.find((step) => step.name === 'Upload actionable diagnostics');
    expect(uploadStep?.if).toBe('always()');
  });

  it('does not run on push or schedule triggers', () => {
    const source = fs.readFileSync(workflowPath, 'utf-8');
    expect(source).not.toMatch(/^\s*push:/m);
    expect(source).not.toMatch(/^\s*schedule:/m);
  });

  it('passes actionlint-equivalent shell syntax checks for every run: block', () => {
    const doc = loadWorkflow();
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.run) continue;
        expect(() =>
          execFileSync('bash', ['-n'], { input: step.run }),
        ).not.toThrow();
      }
    }
  });
});
