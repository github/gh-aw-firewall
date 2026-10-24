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
  env?: Record<string, string>;
}

interface WorkflowJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
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
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.jobs['build-test-artifacts'].permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
    expect(doc.jobs['live-kvm'].permissions).toBeUndefined();
    for (const job of Object.values(doc.jobs)) {
      expect(job.steps?.find(step => step.uses?.startsWith('actions/checkout@'))?.with)
        .toMatchObject({ 'persist-credentials': false });
    }
  });

  it('uses a non-cancelling concurrency group scoped to the ref', () => {
    const doc = loadWorkflow();
    expect(doc.concurrency.group).toBe('cloud-hypervisor-preview-${{ github.ref }}');
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
  });

  it('supports manual/PR preview builds and explicit reusable candidate builds', () => {
    const doc = loadWorkflow();
    expect(Object.keys(doc.on).sort()).toEqual(['pull_request', 'workflow_call', 'workflow_dispatch']);
    const pullRequest = doc.on.pull_request as { types: string[]; paths: string[] };
    expect(pullRequest.types).toEqual(['opened', 'synchronize', 'reopened', 'labeled']);
    expect(pullRequest.paths).toEqual(
      expect.arrayContaining([
        'guest/cloud-hypervisor/**',
        'containers/build-tools/**',
        'containers/cloud-hypervisor/**',
        'src/cloud-hypervisor/**',
        'scripts/ci/cloud-hypervisor-*.sh',
      ]),
    );
    const workflowDispatch = doc.on.workflow_dispatch as {
      inputs: { run_live_kvm: { type: string; default: boolean } };
    };
    expect(workflowDispatch.inputs.run_live_kvm.type).toBe('boolean');
    expect(workflowDispatch.inputs.run_live_kvm.default).toBe(true);
    expect(doc.on.workflow_call).toMatchObject({ inputs: {
      candidate_build: { type: 'boolean', default: true },
      candidate_commit: { type: 'string', required: true },
      run_live_kvm: { type: 'boolean', default: false },
    } });
  });

  it('gates the live-kvm job on manual dispatch or an explicit label, never push/schedule', () => {
    const doc = loadWorkflow();
    const liveKvm = doc.jobs['live-kvm'];
    expect(liveKvm.if).toContain('cloud-hypervisor-kvm');
    expect(liveKvm.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(liveKvm.needs).toBe('build-test-artifacts');
    expect(doc.jobs['build-test-artifacts'].if)
      .toBe("github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'");
    expect(liveKvm.if).toContain("github.event_name == 'workflow_dispatch' && inputs.run_live_kvm");
    expect(liveKvm['runs-on']).toBe('ubuntu-24.04');
  });

  it('requires exact release source admission before builds or privileged live execution', () => {
    const doc = loadWorkflow();
    expect(doc.on.workflow_dispatch).toMatchObject({ inputs: {
      acceptance_commit: { type: 'string', required: false, default: '' },
    } });
    for (const job of Object.values(doc.jobs)) {
      const steps = job.steps!;
      expect(steps[0].with).toMatchObject({ 'fetch-depth': 0, 'fetch-tags': true });
      const gateIndex = steps.findIndex(step => step.name === 'Verify exact primary release checkout');
      expect(gateIndex).toBeGreaterThan(0);
      expect(steps[gateIndex]).toMatchObject({
        if: "github.ref_type == 'tag' || inputs.acceptance_commit != ''",
        env: { AWF_ACCEPTANCE_COMMIT: '${{ inputs.acceptance_commit }}' },
        run: 'node scripts/ci/cloud-hypervisor-primary-release-gate.js',
      });
      const executionIndex = steps.findIndex(step =>
        /build-test-artifacts\.sh|cloud-hypervisor-host-preflight\.sh/.test(step.run || ''));
      expect(executionIndex).toBeGreaterThan(gateIndex);
    }
  });

  it('authenticates same-tag guest archives before host preflight and live VM coverage', () => {
    const doc = loadWorkflow();
    const build = doc.jobs['build-test-artifacts'].steps!
      .find(step => step.name === 'Build and verify pinned artifacts')!;
    expect(build.env?.VERSION).toContain("github.ref_type == 'tag' && github.ref_name");
    expect(build.env?.ARTIFACT_SIGNER_WORKFLOW)
      .toBe('github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor.yml');
    const steps = doc.jobs['live-kvm'].steps!;
    const verifyIndex = steps.findIndex(step => step.name === 'Verify signed release-validation guest bundles');
    const preflightIndex = steps.findIndex(step => step.run?.includes('cloud-hypervisor-host-preflight.sh'));
    expect(verifyIndex).toBeGreaterThan(steps.findIndex(step => step.uses?.startsWith('actions/download-artifact@')));
    expect(preflightIndex).toBeGreaterThan(verifyIndex);
    const verify = steps[verifyIndex];
    expect(verify.if).toBe("github.ref_type == 'tag'");
    expect(verify.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(verify.run).toContain('gh attestation verify');
    expect(verify.run).toContain('--signer-workflow github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor.yml');
    expect(verify.run).toContain('--source-digest "$GITHUB_SHA" --signer-digest "$GITHUB_SHA"');
    expect(verify.run).toContain('--source-ref "$GITHUB_REF" --deny-self-hosted-runners');
    expect(verify.run).toContain('tar --extract');
    expect(verify.run).toContain('awf-cloud-hypervisor-test-x86_64.tar.gz awf-cloud-hypervisor-enclave-rootfs-x86_64.tar.gz');
    expect(verify.run).toContain('.release.tag == $tag and .release.sourceCommit == $commit');
    expect(verify.run).not.toMatch(/\|\| true|continue-on-error/);
  });

  it.each(['', 'signature', 'extraction', 'manifest'])(
    'executes bundle verification fail-closed (failure=%s)', failure => {
      const verify = loadWorkflow().jobs['live-kvm'].steps!
        .find(step => step.name === 'Verify signed release-validation guest bundles')!;
      const script = `
        gh() { echo signature; [ "$FAILURE" != signature ]; }
        tar() { echo extraction; [ "$FAILURE" != extraction ]; }
        jq() { echo manifest; [ "$FAILURE" != manifest ]; }
        ${verify.run}
        echo verified
      `;
      const execute = () => execFileSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env, FAILURE: failure, RUNNER_TEMP: '/unused',
          GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_REF_NAME: 'v1.2.3',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!failure) {
        expect(execute().trim().split('\n')).toEqual([
          'signature', 'extraction', 'signature', 'extraction', 'verified',
        ]);
      } else {
        expect(execute).toThrow();
      }
    },
  );

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

  it('binds candidate artifacts to the caller commit and signs the manifests consumed by AWF', () => {
    const steps = loadWorkflow().jobs['build-test-artifacts'].steps!;
    const bindIndex = steps.findIndex(step => step.name?.startsWith('Bind candidate'));
    const buildIndex = steps.findIndex(step => step.name === 'Build and verify pinned artifacts');
    expect(bindIndex).toBeGreaterThan(-1);
    expect(bindIndex).toBeLessThan(buildIndex);
    expect(steps[bindIndex]).toMatchObject({
      if: 'inputs.candidate_build',
      env: {
        AWF_ENCLAVE_ACCEPTANCE_MODE: 'candidate',
        AWF_ACCEPTANCE_COMMIT: '${{ inputs.candidate_commit }}',
      },
    });
    expect(steps[bindIndex].run).toContain('cloud-hypervisor-enclave-candidate.js configure');
    expect(steps[buildIndex].env?.VERSION).toContain('steps.candidate.outputs.tag');
    expect(steps[buildIndex].env?.ARTIFACT_SIGNER_WORKFLOW)
      .toContain('github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor.yml');
    const primary = steps.find(step => step.name === 'Attest candidate primary manifest')!;
    expect(primary.if).toBe('inputs.candidate_build');
    expect(primary.with?.['subject-path']).toMatch(/\/manifest\.json$/);
    const filenames = steps.find(step => step.name === 'Prepare candidate runtime manifest filenames')!;
    expect(filenames.if).toBe('inputs.candidate_build');
    expect(filenames.run).toContain('cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl');
    expect(filenames.run).toContain('cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
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

  it('does not grant the workflow user direct KVM access', () => {
    const doc = loadWorkflow();
    const source = (doc.jobs['live-kvm'].steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    expect(source).not.toContain('setfacl');
    expect(source).not.toContain('chmod 666 /dev/kvm');
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
    expect(cleanupStep?.run).toContain('awfvm-');
    expect(cleanupStep?.run).toContain('awf-cloud-hypervisor');
    expect(cleanupStep?.run).toContain(
      "pgrep -f '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket'",
    );
    expect(cleanupStep?.run).not.toContain(
      "pgrep -f 'cloud-hypervisor --api-socket'",
    );

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
