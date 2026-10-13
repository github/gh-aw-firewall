import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import {
  BenchmarkResults,
  RecoveryResult,
  RunResult,
  Thresholds,
  evaluate,
} from './nvx-promotion-evaluator';

export type CampaignMode = 'dry-run' | 'canary' | 'full';

export interface CampaignSample {
  sampleId: string;
  runtime: RunResult['runtime'];
  workload: string;
  mode: RunResult['mode'];
  cache: RunResult['cache'];
  resourceProfile: RunResult['resourceProfile'];
  ordinal: number;
}

export interface ResourceLimits {
  cpuCores: number;
  memoryMiB: number;
  pidsMax: number;
  scratchMiB: number;
}

export interface CampaignProvenance {
  compiler: string;
  awf: string;
  runtimeArtifacts: Record<RunResult['runtime'], string>;
  guestImage: string;
  workloadVersions: Record<string, string>;
}

export const RESOURCE_PROFILE_LIMITS: Record<RunResult['resourceProfile'], ResourceLimits> = {
  minimum: { cpuCores: 1, memoryMiB: 2048, pidsMax: 128, scratchMiB: 1024 },
  default: { cpuCores: 2, memoryMiB: 4096, pidsMax: 256, scratchMiB: 2048 },
  elevated: { cpuCores: 4, memoryMiB: 6144, pidsMax: 512, scratchMiB: 4096 },
};

export interface RecoverySample {
  sampleId: string;
  runtime: RunResult['runtime'];
  kind: RecoveryResult['kind'];
  ordinal: number;
}

export interface CampaignManifest {
  schemaVersion: 1;
  campaignId: string;
  mode: CampaignMode;
  dryRun: boolean;
  canary: boolean;
  promotionEligible: boolean;
  sourceCommit: string;
  runnerClass: string;
  runnerImage: string;
  guestImage: string;
  versions: Record<string, string>;
  provenance: CampaignProvenance;
  estimatedRunnerMinutes: number;
  expectedRuns: CampaignSample[];
  expectedRecoveries: RecoverySample[];
}

export interface RunEvidence extends RunResult {
  sampleId: string;
  campaignId: string;
  attemptId: string;
  workflowRunId: string;
  jobId: string;
  workflowAttemptId: string;
  failureCategory: string;
  sourceCommit: string;
  runnerClass: string;
  runnerImage: string;
  guestImage: string;
  versions: Record<string, string>;
  provenance: CampaignProvenance;
  assertions: Record<string, boolean>;
  cacheReadTokens: number;
  cachePreparation: 'cold-cache-flushed' | 'warm-cache-primed';
  resourceLimits: ResourceLimits;
  resourceLimitsEnforced: boolean;
  evidenceKind: 'measured' | 'dry-run';
  rerunOf?: string;
  rerunReason?: string;
}

export interface RecoveryEvidence extends RecoveryResult {
  sampleId: string;
  campaignId: string;
  attemptId: string;
  failureCategory: string;
  workflowRunId: string;
  jobId: string;
  workflowAttemptId: string;
  sourceCommit: string;
  runnerClass: string;
  runnerImage: string;
  guestImage: string;
  versions: Record<string, string>;
  provenance: CampaignProvenance;
  assertions: Record<string, boolean>;
  readinessConfirmed: boolean;
  terminalObserved: boolean;
  managerKilledAfterCleanupRecord: boolean;
  workloadAfterRecovery: boolean;
  evidenceKind: 'measured' | 'dry-run';
  rerunOf?: string;
  rerunReason?: string;
}

export type SampleArtifact =
  | { kind: 'run'; result: RunEvidence }
  | { kind: 'recovery'; result: RecoveryEvidence };

export interface CampaignResults extends BenchmarkResults {
  campaignId: string;
  sourceCommit: string;
  runnerImage: string;
  guestImage: string;
  provenance: CampaignProvenance;
  attempts: RunEvidence[];
  recoveryAttempts: RecoveryEvidence[];
  expectedSampleIds: string[];
  observedSampleIds: string[];
  missingSampleIds: string[];
  unexpectedSampleIds: string[];
  dryRun: boolean;
  canary: boolean;
  promotionEligible: boolean;
}

const INFRASTRUCTURE_FAILURES = new Set([
  'runner-preempted',
  'runner-unavailable',
  'network-infrastructure',
]);
const RECOVERY_ASSERTIONS = [
  'processTreeGone',
  'mountsRestored',
  'namespacesRestored',
  'cgroupsRestored',
  'runDirectoryRemoved',
  'scratchRemoved',
  'snapshotRemoved',
  'cleanupRecordRemoved',
  'kvmAclRestored',
];
const RUNNER_MINUTES_PER_SAMPLE = 10;

function stableId(campaignId: string, parts: string[]): string {
  return createHash('sha256').update([campaignId, ...parts].join('\0')).digest('hex').slice(0, 24);
}

export function createCampaignManifest(
  input: {
    campaignId: string;
    mode: CampaignMode;
    sourceCommit: string;
    runnerClass: string;
    runnerImage: string;
    guestImage: string;
  },
  thresholds: Thresholds,
): CampaignManifest {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.campaignId)) {
    throw new Error('campaignId must be an immutable 1-64 character identifier');
  }
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} is required`);
    }
  }
  if (!thresholds.approvedRunnerClasses.includes(input.runnerClass)) {
    throw new Error(`runner class ${JSON.stringify(input.runnerClass)} is not approved`);
  }
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new Error('sourceCommit must be a full 40-character commit SHA');
  }

  const dryRun = input.mode === 'dry-run';
  const canary = input.mode === 'canary';
  const expectedRuns = canary
    ? (['nvx', 'cloud-hypervisor'] as const).flatMap((runtime) =>
      thresholds.matrix.workloads.map((workload) => {
        const mode = 'sequential' as const;
        const cache = 'cold' as const;
        const resourceProfile = 'default' as const;
        const ordinal = 1;
        return {
          sampleId: stableId(input.campaignId, [
            'canary', runtime, workload, mode, cache, resourceProfile, String(ordinal),
          ]),
          runtime,
          workload,
          mode,
          cache,
          resourceProfile,
          ordinal,
        };
      }))
    : (['nvx', 'cloud-hypervisor'] as const).flatMap((runtime) =>
    thresholds.matrix.workloads.flatMap((workload) =>
      thresholds.matrix.modes.flatMap((mode) =>
        thresholds.matrix.caches.flatMap((cache) =>
          thresholds.matrix.resourceProfiles.flatMap((resourceProfile) => {
            const count = dryRun ? 1 : mode === 'sequential'
              ? thresholds.sample.minSequentialRunsPerLaneRuntime
              : thresholds.sample.minConcurrentRunsPerLaneRuntime;
            return Array.from({ length: count }, (_, index) => {
              const ordinal = index + 1;
              return {
                sampleId: stableId(input.campaignId, [
                  runtime, workload, mode, cache, resourceProfile, String(ordinal),
                ]),
                runtime,
                workload,
                mode,
                cache,
                resourceProfile,
                ordinal,
              };
            });
          }),
        ),
      ),
    ),
  );
  const expectedRecoveries = canary ? [] : (['nvx', 'cloud-hypervisor'] as const).flatMap((runtime) =>
    (['cancellation', 'stale-recovery'] as const).flatMap((kind) =>
      Array.from({ length: dryRun ? 1 : thresholds.sample.minRecoverySamplesPerKindRuntime }, (_, index) => {
        const ordinal = index + 1;
        return {
          sampleId: stableId(input.campaignId, [runtime, kind, String(ordinal)]),
          runtime,
          kind,
          ordinal,
        };
      }),
    ),
  );
  const estimatedRunnerMinutes = dryRun
    ? expectedRuns.length + expectedRecoveries.length
    : (expectedRuns.length + expectedRecoveries.length) * RUNNER_MINUTES_PER_SAMPLE;

  return {
    schemaVersion: 1,
    campaignId: input.campaignId,
    mode: input.mode,
    dryRun,
    canary,
    promotionEligible: input.mode === 'full',
    sourceCommit: input.sourceCommit.toLowerCase(),
    runnerClass: input.runnerClass,
    runnerImage: input.runnerImage,
    guestImage: input.guestImage,
    versions: { ...thresholds.baseline },
    provenance: {
      compiler: thresholds.baseline.ghAw,
      awf: thresholds.baseline.awf,
      runtimeArtifacts: {
        nvx: thresholds.baseline.nvxArtifact,
        'cloud-hypervisor': thresholds.baseline.cloudHypervisorArtifact,
      },
      guestImage: input.guestImage,
      workloadVersions: {
        'build-test': `${input.sourceCommit.toLowerCase()}:phase4-build-v1`,
        'copilot-inference': 'copilot-cli@1.0.95:phase4-prompt-v1',
      },
    },
    estimatedRunnerMinutes,
    expectedRuns,
    expectedRecoveries,
  };
}

function assertRecord(record: Record<string, unknown>, label: string): void {
  const requiredStrings = [
    'sampleId', 'campaignId', 'attemptId', 'workflowRunId', 'jobId',
    'workflowAttemptId', 'sourceCommit', 'runnerClass', 'runnerImage', 'guestImage',
  ];
  for (const key of requiredStrings) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      throw new Error(`${label} is missing ${key}`);
    }
  }
  if (record.evidenceKind !== 'measured' && record.evidenceKind !== 'dry-run') {
    throw new Error(`${label} has invalid evidenceKind`);
  }
  if (typeof record.versions !== 'object' || record.versions === null) {
    throw new Error(`${label} is missing versions`);
  }
  if (typeof record.provenance !== 'object' || record.provenance === null ||
    Array.isArray(record.provenance)) {
    throw new Error(`${label} is missing detailed provenance`);
  }
  if (typeof record.assertions !== 'object' || record.assertions === null ||
    Array.isArray(record.assertions)) {
    throw new Error(`${label} is missing assertion results`);
  }
}

function validateProvenance(
  record: Record<string, unknown>,
  manifest: CampaignManifest,
  thresholds: Thresholds,
  label: string,
): void {
  assertRecord(record, label);
  if (record.campaignId !== manifest.campaignId ||
    record.sourceCommit !== manifest.sourceCommit ||
    record.runnerClass !== manifest.runnerClass ||
    record.runnerImage !== manifest.runnerImage ||
    record.guestImage !== manifest.guestImage ||
    record.evidenceKind !== (manifest.dryRun ? 'dry-run' : 'measured')) {
    throw new Error(`${label} has cross-campaign, stale-baseline, or mismatched provenance`);
  }
  const versions = record.versions as Record<string, unknown>;
  for (const [key, value] of Object.entries(manifest.versions)) {
    if (versions[key] !== value) {
      throw new Error(`${label} baseline ${key} does not match the campaign`);
    }
  }
  const provenance = record.provenance as Record<string, unknown>;
  const exactStringRecord = (actual: unknown, expected: Record<string, string>): boolean => {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const values = actual as Record<string, unknown>;
    return Object.keys(values).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => values[key] === value);
  };
  if (provenance.compiler !== manifest.provenance.compiler ||
    provenance.awf !== manifest.provenance.awf ||
    provenance.guestImage !== manifest.provenance.guestImage ||
    !exactStringRecord(provenance.runtimeArtifacts, manifest.provenance.runtimeArtifacts) ||
    !exactStringRecord(provenance.workloadVersions, manifest.provenance.workloadVersions)) {
    throw new Error(`${label} has mismatched compiler/runtime/guest/workload provenance`);
  }
  const assertions = record.assertions as Record<string, unknown>;
  for (const name of thresholds.zeroTolerance) {
    if (typeof assertions[name] !== 'boolean') {
      throw new Error(`${label} is missing zero-tolerance assertion ${name}`);
    }
  }
}

function validateRun(
  run: RunEvidence,
  sample: CampaignSample,
  manifest: CampaignManifest,
  thresholds: Thresholds,
): void {
  const label = `run ${sample.sampleId}`;
  validateProvenance(run as unknown as Record<string, unknown>, manifest, thresholds, label);
  if (
    run.sampleId !== sample.sampleId ||
    run.runtime !== sample.runtime ||
    run.workload !== sample.workload ||
    run.mode !== sample.mode ||
    run.cache !== sample.cache ||
    run.resourceProfile !== sample.resourceProfile
  ) {
    throw new Error(`${label} does not match its expected matrix cell`);
  }
  if (typeof run.success !== 'boolean' || typeof run.failureCategory !== 'string' ||
    run.failureCategory === '') {
    throw new Error(`${label} is missing a stable success/failure category`);
  }
  if (run.cachePreparation !== (sample.cache === 'cold' ? 'cold-cache-flushed' : 'warm-cache-primed')) {
    throw new Error(`${label} cache preparation does not match its cache state`);
  }
  const expectedLimits = RESOURCE_PROFILE_LIMITS[sample.resourceProfile];
  if (!run.resourceLimits || Object.entries(expectedLimits).some(([key, value]) =>
    run.resourceLimits[key as keyof ResourceLimits] !== value) ||
    run.resourceLimitsEnforced !== true) {
    throw new Error(`${label} resource limits do not match its resource profile`);
  }
  const numericMetrics = [
    'artifactPreflightMs', 'startupMs', 'firstWorkloadMs', 'endToEndMs', 'cleanupMs',
    'peakMemoryMiB', 'scratchMiB', 'hostDiskMiB', 'peakPids', 'cpuSeconds',
    'apiProxyRequests', 'inputTokens', 'outputTokens', 'cacheReadTokens',
  ] as const;
  const positiveMetrics = new Set([
    'startupMs', 'endToEndMs', 'peakMemoryMiB', 'peakPids', 'cpuSeconds',
  ]);
  for (const metric of numericMetrics) {
    if (!Number.isFinite(run[metric]) || run[metric] < 0 ||
      (positiveMetrics.has(metric) && run[metric] === 0)) {
      throw new Error(`${label} has invalid or missing ${metric}`);
    }
  }
  if (!Array.isArray(run.assertionFailures) || !Array.isArray(run.residue)) {
    throw new Error(`${label} is missing assertion failures or residue results`);
  }
  for (const [name, passed] of Object.entries(run.assertions)) {
    if (passed === false && !run.assertionFailures.includes(name)) {
      run.assertionFailures.push(name);
    }
  }
  if (!run.success && run.failureCategory === 'success') {
    throw new Error(`${label} has an inconsistent failure category`);
  }
  if (run.success && run.failureCategory !== 'success') {
    throw new Error(`${label} has an inconsistent success category`);
  }
  if (run.rerunOf !== undefined) {
    if (typeof run.rerunReason !== 'string' ||
      !INFRASTRUCTURE_FAILURES.has(run.rerunReason) ||
      run.assertionFailures.length > 0 || run.residue.length > 0) {
      throw new Error(`${label} is not eligible for an infrastructure-only rerun`);
    }
  }
}

function validateRecovery(
  recovery: RecoveryEvidence,
  sample: RecoverySample,
  manifest: CampaignManifest,
  thresholds: Thresholds,
): void {
  const label = `recovery ${sample.sampleId}`;
  validateProvenance(recovery as unknown as Record<string, unknown>, manifest, thresholds, label);
  if (
    recovery.sampleId !== sample.sampleId ||
    recovery.runtime !== sample.runtime ||
    recovery.kind !== sample.kind ||
    typeof recovery.success !== 'boolean' ||
    typeof recovery.failureCategory !== 'string' ||
    recovery.failureCategory === '' ||
    !Number.isFinite(recovery.durationMs) ||
    recovery.durationMs < 0 ||
    !Array.isArray(recovery.assertionFailures) ||
    !Array.isArray(recovery.residue) ||
    typeof recovery.readinessConfirmed !== 'boolean' ||
    typeof recovery.terminalObserved !== 'boolean' ||
    typeof recovery.managerKilledAfterCleanupRecord !== 'boolean' ||
    typeof recovery.workloadAfterRecovery !== 'boolean'
  ) {
    throw new Error(`${label} is incomplete or does not match its expected recovery cell`);
  }
  if (RECOVERY_ASSERTIONS.some((name) => typeof recovery.assertions[name] !== 'boolean') ||
    (recovery.kind === 'stale-recovery' &&
      typeof recovery.assertions.identityCheckedCleanup !== 'boolean')) {
    throw new Error(`${label} is missing readiness or stale-recovery evidence`);
  }
  const failedAssertions = [
    ...RECOVERY_ASSERTIONS.filter((name) => recovery.assertions[name] === false),
    ...(recovery.readinessConfirmed ? [] : ['readinessConfirmed']),
    ...(recovery.terminalObserved ? [] : ['terminalObserved']),
    ...(recovery.kind === 'stale-recovery' && !recovery.managerKilledAfterCleanupRecord
      ? ['managerKilledAfterCleanupRecord'] : []),
    ...(recovery.kind === 'stale-recovery' && !recovery.workloadAfterRecovery
      ? ['workloadAfterRecovery'] : []),
    ...(recovery.kind === 'stale-recovery' && recovery.assertions.identityCheckedCleanup === false
      ? ['identityCheckedCleanup'] : []),
    ...Object.entries(recovery.assertions)
      .filter(([name, passed]) => passed === false &&
        (name !== 'identityCheckedCleanup' || recovery.kind === 'stale-recovery'))
      .map(([name]) => name),
  ];
  for (const name of failedAssertions) {
    if (!recovery.assertionFailures.includes(name)) recovery.assertionFailures.push(name);
  }
  if ((!recovery.success && recovery.failureCategory === 'success') ||
    (recovery.success && recovery.failureCategory !== 'success')) {
    throw new Error(`${label} has an inconsistent success category`);
  }
  if (recovery.rerunOf !== undefined) {
    if (typeof recovery.rerunReason !== 'string' ||
      !INFRASTRUCTURE_FAILURES.has(recovery.rerunReason) ||
      recovery.assertionFailures.length > 0 || recovery.residue.length > 0) {
      throw new Error(`${label} is not eligible for an infrastructure-only rerun`);
    }
  }
}

export function aggregateCampaign(
  manifest: CampaignManifest,
  artifacts: SampleArtifact[],
  thresholds: Thresholds,
): CampaignResults {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.versions ||
    typeof manifest.versions !== 'object' || Array.isArray(manifest.versions)) {
    throw new Error('unsupported or incomplete campaign manifest');
  }
  if (manifest.mode !== 'dry-run' && manifest.mode !== 'canary' && manifest.mode !== 'full') {
    throw new Error('unsupported or incomplete campaign manifest');
  }
  const canonicalManifest = createCampaignManifest({
    campaignId: manifest.campaignId,
    mode: manifest.mode,
    sourceCommit: manifest.sourceCommit,
    runnerClass: manifest.runnerClass,
    runnerImage: manifest.runnerImage,
    guestImage: manifest.guestImage,
  }, thresholds);
  const samplesMatch = (
    actual: CampaignSample[] | RecoverySample[],
    expected: CampaignSample[] | RecoverySample[],
  ): boolean => {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const byId = new Map(actual.map((sample) => [sample?.sampleId, sample]));
    return byId.size === expected.length &&
      expected.every((sample) => isDeepStrictEqual(byId.get(sample.sampleId), sample));
  };
  if (manifest.dryRun !== canonicalManifest.dryRun ||
    manifest.canary !== canonicalManifest.canary ||
    manifest.promotionEligible !== canonicalManifest.promotionEligible ||
    manifest.estimatedRunnerMinutes !== canonicalManifest.estimatedRunnerMinutes ||
    !isDeepStrictEqual(manifest.versions, canonicalManifest.versions) ||
    !isDeepStrictEqual(manifest.provenance, canonicalManifest.provenance) ||
    !samplesMatch(manifest.expectedRuns, canonicalManifest.expectedRuns) ||
    !samplesMatch(manifest.expectedRecoveries, canonicalManifest.expectedRecoveries)) {
    throw new Error('campaign manifest does not match canonical threshold-derived expectations');
  }
  for (const [key, expected] of Object.entries(thresholds.baseline)) {
    if (manifest.versions[key] !== expected) {
      throw new Error(`campaign baseline ${key} does not match the reviewed thresholds`);
    }
  }
  if (!thresholds.approvedRunnerClasses.includes(manifest.runnerClass)) {
    throw new Error(`campaign runner class ${JSON.stringify(manifest.runnerClass)} is not approved`);
  }

  const expectedRuns = new Map(manifest.expectedRuns.map((sample) => [sample.sampleId, sample]));
  const expectedRecoveries = new Map(manifest.expectedRecoveries.map((sample) => [sample.sampleId, sample]));
  const attempts = new Map<string, RunEvidence[]>();
  const recoveryAttempts = new Map<string, RecoveryEvidence[]>();
  const attemptIds = new Set<string>();

  for (const artifact of artifacts) {
    const result = artifact.result as unknown as Record<string, unknown>;
    if (!result || typeof result !== 'object') throw new Error('malformed sample artifact');
    const sampleId = result.sampleId;
    const attemptId = result.attemptId;
    if (typeof sampleId !== 'string' || typeof attemptId !== 'string' || attemptId === '') {
      throw new Error('sample artifact is missing stable sampleId or attemptId');
    }
    if (attemptIds.has(attemptId)) throw new Error(`duplicate attemptId ${attemptId}`);
    attemptIds.add(attemptId);

    if (artifact.kind === 'run') {
      const sample = expectedRuns.get(sampleId);
      if (!sample) throw new Error(`unexpected run sample ${sampleId}`);
      validateRun(artifact.result, sample, manifest, thresholds);
      const sampleAttempts = attempts.get(sampleId) ?? [];
      sampleAttempts.push(artifact.result);
      attempts.set(sampleId, sampleAttempts);
    } else if (artifact.kind === 'recovery') {
      const sample = expectedRecoveries.get(sampleId);
      if (!sample) throw new Error(`unexpected recovery sample ${sampleId}`);
      validateRecovery(artifact.result, sample, manifest, thresholds);
      const sampleAttempts = recoveryAttempts.get(sampleId) ?? [];
      sampleAttempts.push(artifact.result);
      recoveryAttempts.set(sampleId, sampleAttempts);
    } else {
      throw new Error('sample artifact has an unknown kind');
    }
  }

  const primaryRuns: RunEvidence[] = [];
  for (const [sampleId, sampleAttempts] of attempts) {
    const primary = sampleAttempts.filter((attempt) => attempt.rerunOf === undefined);
    if (primary.length !== 1) {
      throw new Error(`sample ${sampleId} must have exactly one original attempt`);
    }
    for (const rerun of sampleAttempts.filter((attempt) => attempt.rerunOf !== undefined)) {
      if (rerun.rerunOf !== primary[0].attemptId ||
        primary[0].success ||
        !INFRASTRUCTURE_FAILURES.has(primary[0].failureCategory) ||
        primary[0].assertionFailures.length > 0 ||
        primary[0].residue.length > 0) {
        throw new Error(`sample ${sampleId} has an unauthorized rerun`);
      }
    }
    if (sampleAttempts.length > 2) throw new Error(`sample ${sampleId} has duplicate reruns`);
    primaryRuns.push(primary[0]);
  }
  const primaryRecoveries: RecoveryEvidence[] = [];
  for (const [sampleId, sampleAttempts] of recoveryAttempts) {
    const primary = sampleAttempts.filter((attempt) => attempt.rerunOf === undefined);
    if (primary.length !== 1) {
      throw new Error(`recovery sample ${sampleId} must have exactly one original attempt`);
    }
    for (const rerun of sampleAttempts.filter((attempt) => attempt.rerunOf !== undefined)) {
      if (rerun.rerunOf !== primary[0].attemptId ||
        primary[0].success ||
        !INFRASTRUCTURE_FAILURES.has(primary[0].failureCategory) ||
        primary[0].assertionFailures.length > 0 ||
        primary[0].residue.length > 0) {
        throw new Error(`recovery sample ${sampleId} has an unauthorized rerun`);
      }
    }
    if (sampleAttempts.length > 2) throw new Error(`recovery sample ${sampleId} has duplicate reruns`);
    primaryRecoveries.push(primary[0]);
  }

  const expectedSampleIds = [
    ...manifest.expectedRuns.map((sample) => sample.sampleId),
    ...manifest.expectedRecoveries.map((sample) => sample.sampleId),
  ].sort();
  const observedSampleIds = [
    ...attempts.keys(),
    ...recoveryAttempts.keys(),
  ].sort();
  const missingSampleIds = expectedSampleIds.filter((sampleId) => !observedSampleIds.includes(sampleId));
  const unexpectedSampleIds = observedSampleIds.filter((sampleId) => !expectedSampleIds.includes(sampleId));
  if (missingSampleIds.length > 0) {
    throw new Error(`missing samples: ${missingSampleIds.join(', ')}`);
  }
  if (unexpectedSampleIds.length > 0) {
    throw new Error(`unexpected samples: ${unexpectedSampleIds.join(', ')}`);
  }

  return {
    campaignId: manifest.campaignId,
    sourceCommit: manifest.sourceCommit,
    runnerClass: manifest.runnerClass,
    runnerImage: manifest.runnerImage,
    guestImage: manifest.guestImage,
    versions: { ...manifest.versions },
    provenance: structuredClone(manifest.provenance),
    runs: primaryRuns.sort((a, b) => a.sampleId.localeCompare(b.sampleId)),
    recoveries: primaryRecoveries.sort((a, b) => a.sampleId.localeCompare(b.sampleId)),
    attempts: [...attempts.values()].flat().sort((a, b) =>
      a.sampleId.localeCompare(b.sampleId) || a.attemptId.localeCompare(b.attemptId)),
    recoveryAttempts: [...recoveryAttempts.values()].flat().sort((a, b) =>
      a.sampleId.localeCompare(b.sampleId) || a.attemptId.localeCompare(b.attemptId)),
    expectedSampleIds,
    observedSampleIds,
    missingSampleIds,
    unexpectedSampleIds,
    dryRun: manifest.dryRun,
    canary: manifest.canary,
    promotionEligible: manifest.promotionEligible,
  };
}

function dryRunAssertions(thresholds: Thresholds): Record<string, boolean> {
  return Object.fromEntries(thresholds.zeroTolerance.map((name) => [name, true]));
}

export function generateDryRunArtifacts(
  manifest: CampaignManifest,
  thresholds: Thresholds,
  identifiers: { workflowRunId: string; jobId: string; workflowAttemptId: string },
): SampleArtifact[] {
  if (!manifest.dryRun) throw new Error('dry-run evidence requires a dry-run campaign manifest');
  const assertions = dryRunAssertions(thresholds);
  const runs: SampleArtifact[] = manifest.expectedRuns.map((sample) => {
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    return {
      kind: 'run',
      result: {
        ...sample,
        campaignId: manifest.campaignId,
        attemptId: `${sample.sampleId}-attempt-1`,
        ...identifiers,
        success: true,
        failureCategory: 'success',
        artifactPreflightMs: 1,
        startupMs: 1,
        firstWorkloadMs: 1,
        endToEndMs: 1,
        cleanupMs: 1,
        peakMemoryMiB: 1,
        scratchMiB: 1,
        hostDiskMiB: 1,
        peakPids: 1,
        cpuSeconds: 1,
        apiProxyRequests: sample.workload === 'copilot-inference' ? 1 : 0,
        inputTokens: sample.workload === 'copilot-inference' ? 1 : 0,
        outputTokens: sample.workload === 'copilot-inference' ? 1 : 0,
        cacheReadTokens: sample.workload === 'copilot-inference' ? 1 : 0,
        assertionFailures: [],
        residue: [],
        assertions: { ...assertions },
        cachePreparation: sample.cache === 'cold' ? 'cold-cache-flushed' : 'warm-cache-primed',
        resourceLimits: { ...RESOURCE_PROFILE_LIMITS[sample.resourceProfile] },
        resourceLimitsEnforced: true,
        sourceCommit: manifest.sourceCommit,
        runnerClass: manifest.runnerClass,
        runnerImage: manifest.runnerImage,
        guestImage: manifest.guestImage,
        versions: { ...manifest.versions },
        provenance: structuredClone(manifest.provenance),
        evidenceKind: 'dry-run',
      },
    };
  });
  const recoveries: SampleArtifact[] = manifest.expectedRecoveries.map((sample) => {
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    return {
      kind: 'recovery',
      result: {
        ...sample,
        campaignId: manifest.campaignId,
        attemptId: `${sample.sampleId}-attempt-1`,
        failureCategory: 'success',
        ...identifiers,
        success: true,
        durationMs: 1,
        assertionFailures: [],
        residue: [],
        readinessConfirmed: true,
        terminalObserved: true,
        managerKilledAfterCleanupRecord: sample.kind === 'stale-recovery',
        workloadAfterRecovery: sample.kind === 'stale-recovery',
        assertions: {
          ...assertions,
          processTreeGone: true,
          mountsRestored: true,
          namespacesRestored: true,
          cgroupsRestored: true,
          runDirectoryRemoved: true,
          scratchRemoved: true,
          snapshotRemoved: true,
          cleanupRecordRemoved: true,
          kvmAclRestored: true,
          identityCheckedCleanup: sample.kind === 'stale-recovery',
        },
        sourceCommit: manifest.sourceCommit,
        runnerClass: manifest.runnerClass,
        runnerImage: manifest.runnerImage,
        guestImage: manifest.guestImage,
        versions: { ...manifest.versions },
        provenance: structuredClone(manifest.provenance),
        evidenceKind: 'dry-run',
      },
    };
  });
  return [...runs, ...recoveries];
}

function report(results: CampaignResults, thresholds: Thresholds): string {
  const evaluation = evaluate(results, thresholds);
  const lines = [
    '# NVX Phase 4 campaign report',
    '',
    `- Campaign: \`${results.campaignId}\``,
    `- Evidence: ${
      results.dryRun
        ? '**dry-run only (not benchmark data)**'
        : results.canary
          ? '**measured canary (excluded from promotion thresholds)**'
          : 'measured promotion campaign'
    }`,
    `- Runner: \`${results.runnerClass}\``,
    `- Samples: ${results.runs.length} primary runs; ${results.recoveries.length} recovery records`,
    `- Recommendation: **${evaluation.recommendation}**`,
    '',
    '| Runtime / lane | Samples | Success rate | Startup p50 / p95 (ms) | End-to-end p50 / p95 (ms) |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const key of Object.keys(evaluation.summary).sort()) {
    const values = evaluation.summary[key];
    lines.push(
      `| ${key} | ${values.runs} | ${(values.successRate * 100).toFixed(1)}% | ` +
      `${values['startupMs.p50']} / ${values['startupMs.p95']} | ` +
      `${values['endToEndMs.p50']} / ${values['endToEndMs.p95']} |`,
    );
  }
  lines.push('', '## Blockers', '');
  lines.push(...(evaluation.blockers.length ? evaluation.blockers.map((item) => `- ${item}`) : ['- None']));
  lines.push('', '## Unmet gates', '');
  lines.push(...(evaluation.unmetGates.length ? evaluation.unmetGates.map((item) => `- ${item}`) : ['- None']));
  return `${lines.join('\n')}\n`;
}

function loadThresholds(): Thresholds {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'),
    'utf8',
  )) as Thresholds;
}

function usage(): never {
  throw new Error(
    'usage: nvx-benchmark-campaign plan <manifest.json> <campaign-id> <dry-run|canary|full> ' +
    '<source-sha> <runner-class> <runner-image> <guest-image> | dry-run <manifest.json> ' +
    '<samples-dir> <workflow-run-id> <job-id> <workflow-attempt> | aggregate ' +
    '<manifest.json> <samples-dir> <results.json> <report.md>',
  );
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const thresholds = loadThresholds();
  if (command === 'plan') {
    const [manifestPath, campaignId, mode, sourceCommit, runnerClass, runnerImage, guestImage] = args;
    if (!manifestPath || !campaignId || !mode || !sourceCommit || !runnerClass || !runnerImage || !guestImage) usage();
    if (mode !== 'dry-run' && mode !== 'canary' && mode !== 'full') {
      throw new Error('mode must be dry-run, canary, or full');
    }
    const manifest = createCampaignManifest(
      { campaignId, mode, sourceCommit, runnerClass, runnerImage, guestImage },
      thresholds,
    );
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(
      `Campaign ${manifest.campaignId}: ${manifest.expectedRuns.length} runs + ` +
      `${manifest.expectedRecoveries.length} recoveries; estimated ${manifest.estimatedRunnerMinutes} ` +
      `runner-minutes (${(manifest.estimatedRunnerMinutes / 60).toFixed(1)} runner-hours).\n`,
    );
    return;
  }
  if (command === 'dry-run') {
    const [manifestPath, samplesDir, workflowRunId, jobId, workflowAttemptId] = args;
    if (!manifestPath || !samplesDir || !workflowRunId || !jobId || !workflowAttemptId) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const artifacts = generateDryRunArtifacts(manifest, thresholds, {
      workflowRunId, jobId, workflowAttemptId,
    });
    fs.mkdirSync(samplesDir, { recursive: true });
    for (const artifact of artifacts) {
      const result = artifact.result;
      const file = path.join(samplesDir, `${artifact.kind}-${result.sampleId}-${result.attemptId}.json`);
      fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    const results = aggregateCampaign(manifest, artifacts, thresholds);
    const evaluation = evaluate(results, thresholds);
    fs.writeFileSync(path.join(samplesDir, 'benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(samplesDir, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(samplesDir, 'report.md'), report(results, thresholds), { mode: 0o600 });
    if (evaluation.recommendation !== 'retain-preview') {
      throw new Error(`dry-run must retain preview; got ${evaluation.recommendation}`);
    }
    process.stdout.write(`Validated ${artifacts.length} dry-run evidence records; evaluator returned retain-preview.\n`);
    return;
  }
  if (command === 'aggregate') {
    const [manifestPath, samplesDir, resultsPath, reportPath] = args;
    if (!manifestPath || !samplesDir || !resultsPath || !reportPath) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const artifacts = fs.readdirSync(samplesDir)
      .filter((file) => file.endsWith('.json') && !['benchmark-results.json', 'evaluation.json'].includes(file))
      .sort()
      .map((file) => JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8')) as SampleArtifact);
    const results = aggregateCampaign(manifest, artifacts, thresholds);
    const evaluation = evaluate(results, thresholds);
    fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(path.dirname(resultsPath), 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(reportPath, report(results, thresholds), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    if (evaluation.recommendation === 'promote') return;
    process.exitCode = 1;
    return;
  }
  usage();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
