import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  CampaignManifest,
  RESOURCE_PROFILE_LIMITS,
  RunEvidence,
  SampleArtifact,
  aggregateCampaign,
  createCampaignManifest,
  generateDryRunArtifacts,
} from './nvx-benchmark-campaign';
import { evaluate, Thresholds } from './nvx-promotion-evaluator';

const thresholds = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'), 'utf8'),
) as Thresholds;
const identifiers = {
  workflowRunId: 'run-1',
  jobId: 'job-1',
  workflowAttemptId: '1',
};

function manifest(mode: 'dry-run' | 'full' = 'dry-run'): CampaignManifest {
  return createCampaignManifest({
    campaignId: 'campaign-test',
    mode,
    sourceCommit: 'a'.repeat(40),
    runnerClass: 'ubuntu-24.04',
    runnerImage: 'ubuntu-24.04-2026-01',
    guestImage: 'pinned-guest-image',
  }, thresholds);
}

function dryArtifacts(campaign = manifest()): SampleArtifact[] {
  return generateDryRunArtifacts(campaign, thresholds, identifiers);
}

describe('NVX benchmark campaign evidence', () => {
  it('maps cache and resource profiles to fixed matched-runtime inputs', () => {
    expect(RESOURCE_PROFILE_LIMITS).toEqual({
      minimum: { cpuCores: 1, memoryMiB: 2048, pidsMax: 128, scratchMiB: 1024 },
      default: { cpuCores: 2, memoryMiB: 4096, pidsMax: 256, scratchMiB: 2048 },
      elevated: { cpuCores: 4, memoryMiB: 6144, pidsMax: 512, scratchMiB: 4096 },
    });
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const cold = artifacts.find((artifact) =>
      artifact.kind === 'run' && artifact.result.cache === 'cold',
    ) as Extract<SampleArtifact, { kind: 'run' }>;
    const warm = artifacts.find((artifact) =>
      artifact.kind === 'run' && artifact.result.cache === 'warm',
    ) as Extract<SampleArtifact, { kind: 'run' }>;
    expect(cold.result.cachePreparation).toBe('cold-cache-flushed');
    expect(warm.result.cachePreparation).toBe('warm-cache-primed');
    const altered = dryArtifacts(campaign);
    (altered[0] as Extract<SampleArtifact, { kind: 'run' }>).result.resourceLimitsEnforced = false;
    expect(() => aggregateCampaign(campaign, altered, thresholds))
      .toThrow('resource limits do not match');
  });

  it('keeps campaign launches manual, serialized, and dry-run by default', () => {
    const workflowPath = path.join(
      __dirname, '..', '..', '.github', 'workflows', 'nvx-phase-4-benchmark.yml',
    );
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as {
      on: Record<string, unknown>;
      concurrency: { 'cancel-in-progress': boolean };
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    const source = fs.readFileSync(workflowPath, 'utf8');
    expect(source).toContain('default: dry-run');
    expect(source).toContain('Full sample execution is not enabled');
    expect(source).toContain('10,000-minute');
  });

  it('keeps the real canary bounded, serialized, matched, and promotion-ineligible', () => {
    const workflowPath = path.join(
      __dirname, '..', '..', '.github', 'workflows', 'nvx-phase-4-canary.yml',
    );
    const source = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(source) as {
      on: Record<string, unknown>;
      concurrency: { 'cancel-in-progress': boolean };
      jobs: {
        canary: {
          strategy: {
            'fail-fast': boolean;
            'max-parallel': number;
            matrix: { runtime: string[]; workload: string[] };
          };
          'runs-on': string;
        };
      };
    };
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.canary['runs-on']).toBe('ubuntu-24.04');
    expect(workflow.jobs.canary.strategy).toMatchObject({
      'fail-fast': false,
      'max-parallel': 1,
      matrix: {
        runtime: ['nvx', 'cloud-hypervisor'],
        workload: ['build-test', 'copilot-inference'],
      },
    });
    expect(source).toContain('v0.91.9');
    expect(source).toContain('v0.28.54');
    expect(source).toContain('install_copilot_cli.sh" 1.0.95');
    expect(source).toContain("matrix.runtime == 'nvx' && 'musl' || 'glibc'");
    expect(source).toContain('AWF_PHASE4_KVM_ACL_BASELINE');
    expect(source).toContain("getSafeHostUid()");
    expect(source).toContain("'awf:x:%s:%s:AWF workload:/home/awf:/bin/sh");
    expect(source).toContain('install -d -o root -g root -m 1777 "$layer/tmp"');
    expect(source).toContain('promotionEligible == false');
    expect(source).not.toContain('mode: full');

    const harness = fs.readFileSync(path.join(
      __dirname, '..', '..', 'scripts', 'ci', 'nvx-phase4-canary-runtime.sh',
    ), 'utf8');
    expect(harness).toContain('--container-workdir /workspace');
    expect(harness).toContain('test -f dist/cli.js');
    expect(harness).not.toContain('test -x dist/cli.js');
    expect(harness).toContain('$RUNNER_TEMP/gh-aw/nvx-engine/copilot');
    expect(harness).toContain('copilot_host=$(command -v copilot)');
    expect(harness).toContain('GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS');
    expect(harness).toContain('0.28.54,squid=sha256:960930db');
    expect(harness).toContain("copilot_placeholder=\"ghu_$(printf '%036s' '' | tr ' ' a)\"");
    expect(harness).toContain('"/proc/$runtime_pid/cgroup"');
    expect(harness).toContain('sudo test -r "/proc/$runtime_pid/cgroup"');
    expect(harness).toContain('sudo test -f "$candidate/memory.max"');
    expect(harness).toContain("! -path '/sys/fs/cgroup/awf-nvx'");
    expect(harness).toContain('setfacl --restore="$evidence_dir/kvm-acl-before.txt"');
    expect(harness).toContain('--cloud-hypervisor-vcpus 1');
    expect(harness).toContain('--nvx-memory-mib 4096');
    expect(harness).toContain('[ "$observed_memory_max" = 4563402752 ]');
    expect(harness).toContain('[ "$cpu_quota" = 200000 ]');
    expect(harness).toContain('runtime-ready');
    expect(harness).toContain('resourceLimitsEnforced:$resourceLimitsEnforced');
    expect(harness).toContain('residue+=("runtime-process")');
    expect(harness).not.toContain('--argjson immutableArtifacts true');
    expect(harness).not.toContain('--argjson boundedScratch true');
  });

  it('expands every required matrix cell and uses the approved sample sizes', () => {
    const campaign = manifest('full');
    expect(campaign.expectedRuns).toHaveLength(960);
    expect(campaign.expectedRecoveries).toHaveLength(40);
    expect(campaign.estimatedRunnerMinutes).toBe(10_000);
    expect(new Set(campaign.expectedRuns.map((sample) =>
      [sample.runtime, sample.workload, sample.mode, sample.cache, sample.resourceProfile].join('/'),
    )).size).toBe(48);
  });

  it('generates one explicitly marked pipeline sample for every dry-run shape', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const result = aggregateCampaign(campaign, artifacts, thresholds);
    expect(result.runs).toHaveLength(48);
    expect(result.recoveries).toHaveLength(4);
    expect(result.runs.every((run) =>
      (run as RunEvidence).evidenceKind === 'dry-run' &&
      run.assertionFailures.length === 0 && run.residue.length === 0,
    )).toBe(true);
    expect(result.expectedSampleIds).toEqual(result.observedSampleIds);
    expect(result.dryRun).toBe(true);
  });

  it('creates stable sample IDs for resume and rejects invalid campaign identifiers', () => {
    expect(manifest().expectedRuns.map((sample) => sample.sampleId))
      .toEqual(manifest().expectedRuns.map((sample) => sample.sampleId));
    expect(() => createCampaignManifest({
      campaignId: '../escape',
      mode: 'dry-run',
      sourceCommit: 'a'.repeat(40),
      runnerClass: 'ubuntu-24.04',
      runnerImage: 'runner',
      guestImage: 'guest',
    }, thresholds)).toThrow('immutable');
  });

  it('rejects manifests that do not match the canonical campaign matrix', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const missingRun = structuredClone(campaign);
    missingRun.expectedRuns.pop();
    expect(() => aggregateCampaign(missingRun, artifacts, thresholds))
      .toThrow('canonical threshold-derived expectations');

    const missingRecovery = structuredClone(campaign);
    missingRecovery.expectedRecoveries.pop();
    expect(() => aggregateCampaign(missingRecovery, artifacts, thresholds))
      .toThrow('canonical threshold-derived expectations');

    const wrongMode = structuredClone(campaign);
    wrongMode.dryRun = false;
    expect(() => aggregateCampaign(wrongMode, artifacts, thresholds))
      .toThrow('canonical threshold-derived expectations');
  });

  it('rejects missing, duplicate, and unexpected samples', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    expect(() => aggregateCampaign(campaign, artifacts.slice(1), thresholds)).toThrow('missing samples');
    expect(() => aggregateCampaign(campaign, [...artifacts, artifacts[0]], thresholds)).toThrow('duplicate attemptId');

    const unexpected = structuredClone(artifacts);
    (unexpected[0].result as RunEvidence).sampleId = 'not-expected';
    expect(() => aggregateCampaign(campaign, unexpected, thresholds)).toThrow('unexpected run sample');
  });

  it('rejects stale baseline, runner, campaign, and missing measurement evidence', () => {
    const campaign = manifest();
    const stale = dryArtifacts(campaign);
    (stale[0].result as RunEvidence).versions.awf = 'v0.0.0';
    expect(() => aggregateCampaign(campaign, stale, thresholds)).toThrow('baseline awf');
    const staleWorkload = dryArtifacts(campaign);
    (staleWorkload[0].result as RunEvidence).provenance.workloadVersions['build-test'] =
      'different-workload';
    expect(() => aggregateCampaign(campaign, staleWorkload, thresholds))
      .toThrow('mismatched compiler/runtime/guest/workload provenance');

    const wrongRunner = dryArtifacts(campaign);
    (wrongRunner[0].result as RunEvidence).runnerClass = 'unapproved-runner';
    expect(() => aggregateCampaign(campaign, wrongRunner, thresholds)).toThrow('mismatched provenance');

    const missingMetric = dryArtifacts(campaign);
    (missingMetric[0].result as RunEvidence).hostDiskMiB = Number.NaN;
    expect(() => aggregateCampaign(campaign, missingMetric, thresholds)).toThrow('hostDiskMiB');
  });

  it('rejects zero values for metrics that must be observed as positive', () => {
    const campaign = manifest();
    for (const metric of ['startupMs', 'endToEndMs', 'peakMemoryMiB', 'peakPids', 'cpuSeconds'] as const) {
      const artifacts = dryArtifacts(campaign);
      const run = (artifacts[0] as Extract<SampleArtifact, { kind: 'run' }>).result;
      run[metric] = 0;
      expect(() => aggregateCampaign(campaign, artifacts, thresholds)).toThrow(metric);
    }
  });

  it('keeps an eligible infrastructure rerun but scores its failed original only once', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const first = artifacts[0] as Extract<SampleArtifact, { kind: 'run' }>;
    first.result.success = false;
    first.result.failureCategory = 'runner-preempted';
    const rerun: SampleArtifact = {
      kind: 'run',
      result: {
        ...first.result,
        attemptId: `${first.result.sampleId}-attempt-2`,
        success: true,
        failureCategory: 'success',
        rerunOf: first.result.attemptId,
        rerunReason: 'runner-preempted',
      },
    };
    const result = aggregateCampaign(campaign, [...artifacts, rerun], thresholds);
    expect(result.attempts).toHaveLength(49);
    expect(result.runs).toHaveLength(48);
    expect((result.runs as RunEvidence[])
      .find((run) => run.sampleId === first.result.sampleId)?.success).toBe(false);

    const forbidden = structuredClone(rerun);
    forbidden.result.rerunReason = 'security-failure';
    expect(() => aggregateCampaign(campaign, [...artifacts, forbidden], thresholds))
      .toThrow('infrastructure-only rerun');
  });

  it('propagates assertion failures and residue rather than retrying them', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const first = artifacts[0] as Extract<SampleArtifact, { kind: 'run' }>;
    first.result.assertions.credentialIsolation = false;
    first.result.residue.push('run-directory');
    const result = aggregateCampaign(campaign, artifacts, thresholds);
    const affected = (result.runs as RunEvidence[]).find((run) => run.sampleId === first.result.sampleId)!;
    expect(affected.assertionFailures).toContain('credentialIsolation');
    expect(affected.residue).toContain('run-directory');
    expect(() => aggregateCampaign(campaign, [
      ...artifacts,
      {
        kind: 'run',
        result: {
          ...first.result,
          attemptId: `${first.result.sampleId}-attempt-2`,
          rerunOf: first.result.attemptId,
          rerunReason: 'runner-preempted',
        },
      },
    ], thresholds)).toThrow('infrastructure-only rerun');

    const contaminatedOriginal = structuredClone(first);
    contaminatedOriginal.result.sampleId = campaign.expectedRuns[1].sampleId;
    contaminatedOriginal.result.attemptId = `${contaminatedOriginal.result.sampleId}-attempt-1`;
    contaminatedOriginal.result.runtime = campaign.expectedRuns[1].runtime;
    contaminatedOriginal.result.workload = campaign.expectedRuns[1].workload;
    contaminatedOriginal.result.mode = campaign.expectedRuns[1].mode;
    contaminatedOriginal.result.cache = campaign.expectedRuns[1].cache;
    contaminatedOriginal.result.resourceProfile = campaign.expectedRuns[1].resourceProfile;
    contaminatedOriginal.result.resourceLimits = {
      ...RESOURCE_PROFILE_LIMITS[campaign.expectedRuns[1].resourceProfile],
    };
    contaminatedOriginal.result.cachePreparation = 'cold-cache-flushed';
    contaminatedOriginal.result.failureCategory = 'runner-preempted';
    contaminatedOriginal.result.success = false;
    const contaminatedRetry: SampleArtifact = {
      kind: 'run',
      result: {
        ...contaminatedOriginal.result,
        attemptId: `${contaminatedOriginal.result.sampleId}-attempt-2`,
        success: true,
        failureCategory: 'success',
        assertionFailures: [],
        residue: [],
        assertions: { ...contaminatedOriginal.result.assertions, credentialIsolation: true },
        rerunOf: contaminatedOriginal.result.attemptId,
        rerunReason: 'runner-preempted',
      },
    };
    expect(() => aggregateCampaign(campaign, [
      ...artifacts.filter((artifact) =>
        artifact.result.sampleId !== contaminatedOriginal.result.sampleId,
      ),
      contaminatedOriginal,
      contaminatedRetry,
    ], thresholds)).toThrow('unauthorized rerun');
  });

  it('requires readiness and complete identity-checked cleanup evidence for recovery', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const recovery = artifacts.find((artifact) => artifact.kind === 'recovery') as
      Extract<SampleArtifact, { kind: 'recovery' }>;
    recovery.result.readinessConfirmed = undefined as unknown as boolean;
    expect(() => aggregateCampaign(campaign, artifacts, thresholds))
      .toThrow('incomplete or does not match its expected recovery cell');
  });

  it('passes failed cleanup assertions to the evaluator as stop-promotion blockers', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const recovery = artifacts.find((artifact) => artifact.kind === 'recovery') as
      Extract<SampleArtifact, { kind: 'recovery' }>;
    recovery.result.assertions.cleanupRecordRemoved = false;

    const results = aggregateCampaign(campaign, artifacts, thresholds);
    expect(results.recoveries.some((item) =>
      item.assertionFailures.includes('cleanupRecordRemoved'),
    )).toBe(true);
    expect(evaluate(results, thresholds).recommendation).toBe('stop-promotion');
  });

  it('allows one linked infrastructure-only recovery rerun but scores the original', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const first = artifacts.find((artifact) => artifact.kind === 'recovery') as
      Extract<SampleArtifact, { kind: 'recovery' }>;
    first.result.success = false;
    first.result.failureCategory = 'runner-preempted';
    const rerun: SampleArtifact = {
      kind: 'recovery',
      result: {
        ...first.result,
        attemptId: `${first.result.sampleId}-attempt-2`,
        success: true,
        failureCategory: 'success',
        rerunOf: first.result.attemptId,
        rerunReason: 'runner-preempted',
      },
    };

    const results = aggregateCampaign(campaign, [...artifacts, rerun], thresholds);
    expect(results.recoveryAttempts).toHaveLength(5);
    expect(results.recoveries.some((item) => !item.success)).toBe(true);
    expect(evaluate(results, thresholds).recommendation).toBe('stop-promotion');

    const unauthorized = structuredClone(rerun);
    if (unauthorized.kind === 'recovery') unauthorized.result.rerunReason = 'security-failure';
    expect(() => aggregateCampaign(campaign, [...artifacts, unauthorized], thresholds))
      .toThrow('infrastructure-only rerun');
  });

  it('aggregates independently of input artifact ordering', () => {
    const campaign = manifest();
    const artifacts = dryArtifacts(campaign);
    const forward = aggregateCampaign(campaign, artifacts, thresholds);
    const reverse = aggregateCampaign(campaign, [...artifacts].reverse(), thresholds);
    expect(reverse.runs).toEqual(forward.runs);
    expect(reverse.recoveries).toEqual(forward.recoveries);
    expect(reverse.observedSampleIds).toEqual(forward.observedSampleIds);
  });
});
