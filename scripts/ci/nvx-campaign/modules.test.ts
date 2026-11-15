import { assertRecord, validateProvenance, validateRecovery, validateRun } from './validate';
import * as fs from 'fs';
import * as path from 'path';
import * as campaign from '../nvx-benchmark-campaign';
import * as aggregation from './aggregate';
import * as manifest from './manifest';
import * as reporting from './report';
import type { Thresholds } from '../nvx-promotion-evaluator';
import type { RecoveryEvidence, RunEvidence, SampleArtifact } from './manifest';

const thresholds: Thresholds = {
  ...reporting.loadThresholds(),
  matrix: {
    workloads: ['build-test'],
    modes: ['sequential'],
    caches: ['cold'],
    resourceProfiles: ['default'],
  },
};
const planned = manifest.createCampaignManifest(
  {
    campaignId: 'module-regression',
    mode: 'dry-run',
    sourceCommit: 'a'.repeat(40),
    runnerClass: 'ubuntu-24.04',
    runnerImage: 'ubuntu24',
    guestImage: 'pinned-guest-image',
  },
  thresholds,
);
let artifacts: SampleArtifact[];

beforeAll(() => {
  artifacts = reporting.generateDryRunArtifacts(planned, thresholds, {
    workflowRunId: 'module-run',
    jobId: 'module-job',
    workflowAttemptId: '1',
  });
});

describe('NVX campaign module boundaries', () => {
  it('preserves the facade runtime API without exporting internal helpers', () => {
    expect(Object.keys(campaign).sort()).toEqual([
      'RESOURCE_PROFILE_LIMITS',
      'aggregateCampaign',
      'createCampaignCells',
      'createCampaignManifest',
      'generateDryRunArtifacts',
      'isSuccessfulPilot',
      'selectPendingCellSamples',
      'validateProgressionEvidence',
    ]);
  });

  it('re-exports the original module functions and resource limits by identity', () => {
    expect(campaign.RESOURCE_PROFILE_LIMITS).toBe(manifest.RESOURCE_PROFILE_LIMITS);
    expect(campaign.createCampaignManifest).toBe(manifest.createCampaignManifest);
    expect(campaign.createCampaignCells).toBe(manifest.createCampaignCells);
    expect(campaign.selectPendingCellSamples).toBe(manifest.selectPendingCellSamples);
    expect(campaign.aggregateCampaign).toBe(aggregation.aggregateCampaign);
    expect(campaign.isSuccessfulPilot).toBe(aggregation.isSuccessfulPilot);
    expect(campaign.validateProgressionEvidence).toBe(aggregation.validateProgressionEvidence);
    expect(campaign.generateDryRunArtifacts).toBe(reporting.generateDryRunArtifacts);
  });

  it('loads the reviewed thresholds relative to the nested module, not cwd', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'nvx-promotion-thresholds.json'), 'utf8'),
    );
    const previousCwd = process.cwd();
    try {
      process.chdir(__dirname);
      expect(reporting.loadThresholds()).toEqual(expected);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('exposes record and provenance validation without invoking the CLI', () => {
    const run = structuredClone(artifacts.find((artifact) => artifact.kind === 'run')!.result);
    const record = run as unknown as Record<string, unknown>;
    expect(() => assertRecord(record, 'direct record')).not.toThrow();
    expect(() => assertRecord({}, 'direct record')).toThrow('direct record is missing sampleId');
    expect(() => validateProvenance(record, planned, thresholds, 'direct record')).not.toThrow();
    record.campaignId = 'another-campaign';
    expect(() => validateProvenance(record, planned, thresholds, 'direct record')).toThrow(
      'direct record has cross-campaign, stale-baseline, or mismatched provenance',
    );
  });

  it('retains direct run-validator assertion mutation and deduplication', () => {
    const run = structuredClone(artifacts.find((artifact) => artifact.kind === 'run')!.result) as RunEvidence;
    const sample = planned.expectedRuns.find((candidate) => candidate.sampleId === run.sampleId)!;
    expect(() => validateRun(run, sample, planned, thresholds)).not.toThrow();
    run.success = false;
    run.failureCategory = 'workload-failed';
    run.resourceLimitsEnforced = false;
    run.assertions[thresholds.zeroTolerance[0]] = false;
    validateRun(run, sample, planned, thresholds);
    validateRun(run, sample, planned, thresholds);
    expect(run.assertionFailures).toEqual([thresholds.zeroTolerance[0], 'resourceLimitsEnforced']);
  });

  it('retains direct recovery-validator assertion mutation and deduplication', () => {
    const recovery = structuredClone(
      artifacts.find((artifact) => artifact.kind === 'recovery' && artifact.result.kind === 'stale-recovery')!.result,
    ) as RecoveryEvidence;
    const sample = planned.expectedRecoveries.find((candidate) => candidate.sampleId === recovery.sampleId)!;
    expect(() => validateRecovery(recovery, sample, planned, thresholds)).not.toThrow();
    recovery.assertions.processTreeGone = false;
    recovery.readinessConfirmed = false;
    validateRecovery(recovery, sample, planned, thresholds);
    validateRecovery(recovery, sample, planned, thresholds);
    expect(recovery.assertionFailures).toEqual(['processTreeGone', 'readinessConfirmed']);
  });

  it('renders dry-run artifacts through the direct aggregation and report modules', () => {
    expect(artifacts).toHaveLength(6);
    expect(artifacts.every((artifact) => artifact.result.evidenceKind === 'dry-run')).toBe(true);
    const results = aggregation.aggregateCampaign(planned, structuredClone(artifacts), thresholds);
    const report = reporting.report(results, thresholds);
    expect(report).toContain('# NVX Phase 4 campaign report\n');
    expect(report).toContain('- Evidence: **dry-run only (not benchmark data)**\n');
    expect(report).toContain('- Samples: 2 primary runs; 4 recovery records\n');
    expect(report).toContain('- Recommendation: **retain-preview**\n');
    const rows = report.split('\n').filter((line) => /^\| (cloud-hypervisor|nvx):/.test(line));
    expect(rows).toEqual([
      '| cloud-hypervisor:build-test/sequential/cold/default | 1 | 100.0% | 1 / 1 | 1 / 1 |',
      '| nvx:build-test/sequential/cold/default | 1 | 100.0% | 1 / 1 | 1 / 1 |',
    ]);
    expect(report.endsWith('\n')).toBe(true);
  });
});
