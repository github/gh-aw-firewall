import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { BenchmarkResults, RecoveryResult, RunResult, Thresholds, evaluate } from './nvx-promotion-evaluator';

export type CampaignMode = 'dry-run' | 'canary' | 'pilot-100' | 'pilot-1000' | 'full';

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
  observedGuestTools?: { node: string; curl: string };
  nvxGuestToolchain?: {
    layerSha256: string;
    packageInventorySha256: string;
    packages: string[];
    tools: Record<'bash' | 'curl' | 'node' | 'npm', string>;
  };
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

export interface CampaignCell {
  cellId: string;
  kind: 'run' | 'recovery';
  runtime: RunResult['runtime'];
  workload?: string;
  mode?: RunResult['mode'];
  cache?: RunResult['cache'];
  resourceProfile?: RunResult['resourceProfile'];
  recoveryKind?: RecoveryResult['kind'];
  sampleIds: string[];
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

export type SampleArtifact = { kind: 'run'; result: RunEvidence } | { kind: 'recovery'; result: RecoveryEvidence };

export interface CampaignResults extends Omit<BenchmarkResults, 'runs' | 'recoveries'> {
  campaignId: string;
  mode: CampaignMode;
  sourceCommit: string;
  runnerImage: string;
  guestImage: string;
  provenance: CampaignProvenance;
  runs: RunEvidence[];
  recoveries: RecoveryEvidence[];
  attempts: RunEvidence[];
  recoveryAttempts: RecoveryEvidence[];
  expectedSampleIds: string[];
  observedSampleIds: string[];
  missingSampleIds: string[];
  unexpectedSampleIds: string[];
  dryRun: boolean;
  canary: boolean;
  promotionEligible: boolean;
  estimatedRunnerMinutes: number;
}

const INFRASTRUCTURE_FAILURES = new Set(['runner-preempted', 'runner-unavailable', 'network-infrastructure']);
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
const MAX_CAMPAIGN_SAMPLES = 1_000;
const MAX_CELL_SAMPLES = 20;
const EXECUTION_SAMPLE_COUNTS: Partial<Record<CampaignMode, number>> = {
  'pilot-100': 10,
  'pilot-1000': 100,
  full: 1_000,
};

export function getRunnerImageFamily(runnerImage: string): string {
  const match = /^([A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)?$/.exec(runnerImage);
  if (!match) throw new Error(`runner image ${JSON.stringify(runnerImage)} is invalid`);
  return match[1];
}

function stableId(campaignId: string, parts: string[]): string {
  return createHash('sha256')
    .update([campaignId, ...parts].join('\0'))
    .digest('hex')
    .slice(0, 24);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const runnerImageFamily = getRunnerImageFamily(input.runnerImage);
  if (!thresholds.approvedRunnerImageFamilies.includes(runnerImageFamily)) {
    throw new Error(`runner image family ${JSON.stringify(runnerImageFamily)} is not approved`);
  }
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) {
    throw new Error('sourceCommit must be a full 40-character commit SHA');
  }

  const dryRun = input.mode === 'dry-run';
  const canary = input.mode === 'canary';
  const runtimes = ['nvx', 'cloud-hypervisor'] as const;
  const expectedRuns = canary
    ? runtimes.flatMap((runtime) =>
        thresholds.matrix.workloads.map((workload) => {
          const mode = 'sequential' as const;
          const cache = 'cold' as const;
          const resourceProfile = 'default' as const;
          const ordinal = 1;
          return {
            sampleId: stableId(input.campaignId, ['canary', runtime, workload, mode, cache, resourceProfile, String(ordinal)]),
            runtime,
            workload,
            mode,
            cache,
            resourceProfile,
            ordinal,
          };
        }),
      )
    : input.mode === 'pilot-100'
      ? runtimes.flatMap((runtime) =>
          [
            ...thresholds.matrix.workloads.map((workload) => ({
              workload,
              mode: 'sequential' as const,
              cache: 'cold' as const,
              resourceProfile: 'default' as const,
            })),
            {
              workload: 'build-test',
              mode: 'concurrent' as const,
              cache: 'cold' as const,
              resourceProfile: 'default' as const,
            },
          ].map(({ workload, mode, cache, resourceProfile }) => ({
            sampleId: stableId(input.campaignId, [runtime, workload, mode, cache, resourceProfile, '1']),
            runtime,
            workload,
            mode,
            cache,
            resourceProfile,
            ordinal: 1,
          })),
        )
      : runtimes.flatMap((runtime) =>
        thresholds.matrix.workloads.flatMap((workload) =>
          thresholds.matrix.modes.flatMap((mode) =>
            thresholds.matrix.caches.flatMap((cache) =>
              thresholds.matrix.resourceProfiles.flatMap((resourceProfile) => {
                const count = dryRun
                  ? 1
                  : input.mode === 'pilot-1000'
                    ? 2
                  : mode === 'sequential'
                    ? thresholds.sample.minSequentialRunsPerLaneRuntime
                    : thresholds.sample.minConcurrentRunsPerLaneRuntime;
                return Array.from({ length: count }, (_, index) => {
                  const ordinal = index + 1;
                  return {
                    sampleId: stableId(input.campaignId, [runtime, workload, mode, cache, resourceProfile, String(ordinal)]),
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
  const expectedRecoveries = canary
    ? []
    : runtimes.flatMap((runtime) =>
        (['cancellation', 'stale-recovery'] as const).flatMap((kind) =>
          Array.from(
            {
              length:
                dryRun || input.mode === 'pilot-100' || input.mode === 'pilot-1000'
                  ? 1
                  : thresholds.sample.minRecoverySamplesPerKindRuntime,
            },
            (_, index) => {
              const ordinal = index + 1;
              return {
                sampleId: stableId(input.campaignId, [runtime, kind, String(ordinal)]),
                runtime,
                kind,
                ordinal,
              };
            },
          ),
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

export function createCampaignCells(manifest: CampaignManifest): CampaignCell[] {
  const expectedSampleCount = EXECUTION_SAMPLE_COUNTS[manifest.mode];
  if (!expectedSampleCount || manifest.expectedRuns.length + manifest.expectedRecoveries.length !== expectedSampleCount) {
    throw new Error('execution cells require a canonical measured campaign tier');
  }
  const cells = new Map<string, CampaignCell>();
  for (const sample of manifest.expectedRuns) {
    const cellId = ['run', sample.runtime, sample.workload, sample.mode, sample.cache, sample.resourceProfile].join('-');
    const cell = cells.get(cellId) ?? {
      cellId,
      kind: 'run' as const,
      runtime: sample.runtime,
      workload: sample.workload,
      mode: sample.mode,
      cache: sample.cache,
      resourceProfile: sample.resourceProfile,
      sampleIds: [],
    };
    cell.sampleIds.push(sample.sampleId);
    cells.set(cellId, cell);
  }
  for (const sample of manifest.expectedRecoveries) {
    const cellId = ['recovery', sample.runtime, sample.kind].join('-');
    const cell = cells.get(cellId) ?? {
      cellId,
      kind: 'recovery' as const,
      runtime: sample.runtime,
      recoveryKind: sample.kind,
      sampleIds: [],
    };
    cell.sampleIds.push(sample.sampleId);
    cells.set(cellId, cell);
  }
  const result = [...cells.values()]
    .flatMap((cell) =>
      Array.from({ length: Math.ceil(cell.sampleIds.length / MAX_CELL_SAMPLES) }, (_, index) => ({
        ...cell,
        cellId: `${cell.cellId}-part-${String(index + 1).padStart(2, '0')}`,
        sampleIds: cell.sampleIds.slice(index * MAX_CELL_SAMPLES, (index + 1) * MAX_CELL_SAMPLES),
      })),
    )
    .sort((left, right) => left.cellId.localeCompare(right.cellId));
  if (
    result.length < 1 ||
    result.some((cell) => cell.sampleIds.length < 1 || cell.sampleIds.length > MAX_CELL_SAMPLES) ||
    new Set(result.flatMap((cell) => cell.sampleIds)).size !== expectedSampleCount
  ) {
    throw new Error('campaign execution cells are incomplete, duplicated, or unbounded');
  }
  return result;
}

export function selectPendingCellSamples(
  manifest: CampaignManifest,
  cell: CampaignCell,
  artifacts: SampleArtifact[],
  allowInfrastructureRetry: boolean,
): Array<{
  sampleId: string;
  attempt: 1 | 2;
  rerunOf?: string;
  rerunReason?: string;
}> {
  const canonicalCell = createCampaignCells(manifest).find((candidate) => candidate.cellId === cell.cellId);
  if (!canonicalCell || !isDeepStrictEqual(canonicalCell, cell)) {
    throw new Error('campaign cell does not match the canonical campaign-tier plan');
  }
  const attempts = new Map<string, Array<RunEvidence | RecoveryEvidence>>();
  const attemptIds = new Set<string>();
  const thresholds = loadThresholds();
  for (const artifact of artifacts) {
    const result = artifact.result;
    if (artifact.kind === 'run') {
      const sample = manifest.expectedRuns.find((candidate) => candidate.sampleId === result.sampleId);
      if (!sample) throw new Error(`resume evidence contains unexpected run sample ${result.sampleId}`);
      validateRun(artifact.result, sample, manifest, thresholds);
    } else if (artifact.kind === 'recovery') {
      const sample = manifest.expectedRecoveries.find((candidate) => candidate.sampleId === result.sampleId);
      if (!sample) {
        throw new Error(`resume evidence contains unexpected recovery sample ${result.sampleId}`);
      }
      validateRecovery(artifact.result, sample, manifest, thresholds);
    } else {
      throw new Error('resume evidence has an unknown kind');
    }
    if (attemptIds.has(result.attemptId)) throw new Error(`duplicate attemptId ${result.attemptId}`);
    attemptIds.add(result.attemptId);
    const values = attempts.get(result.sampleId) ?? [];
    values.push(result);
    attempts.set(result.sampleId, values);
  }
  const pending: Array<{
    sampleId: string;
    attempt: 1 | 2;
    rerunOf?: string;
    rerunReason?: string;
  }> = [];
  for (const sampleId of cell.sampleIds) {
    const values = attempts.get(sampleId) ?? [];
    const originals = values.filter((attempt) => attempt.rerunOf === undefined);
    const reruns = values.filter((attempt) => attempt.rerunOf !== undefined);
    if (originals.length > 1 || reruns.length > 1 || values.length > 2) {
      throw new Error(`sample ${sampleId} has duplicate or unbounded attempts`);
    }
    if (originals.length === 0) {
      pending.push({ sampleId, attempt: 1 });
      continue;
    }
    const original = originals[0];
    if (
      original.success ||
      original.assertionFailures.length > 0 ||
      original.residue.length > 0 ||
      !INFRASTRUCTURE_FAILURES.has(original.failureCategory)
    ) {
      continue;
    }
    if (allowInfrastructureRetry && reruns.length === 0) {
      pending.push({
        sampleId,
        attempt: 2,
        rerunOf: original.attemptId,
        rerunReason: original.failureCategory,
      });
    }
  }
  return pending;
}

function assertRecord(record: Record<string, unknown>, label: string): void {
  const requiredStrings = [
    'sampleId',
    'campaignId',
    'attemptId',
    'workflowRunId',
    'jobId',
    'workflowAttemptId',
    'sourceCommit',
    'runnerClass',
    'runnerImage',
    'guestImage',
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
  if (typeof record.provenance !== 'object' || record.provenance === null || Array.isArray(record.provenance)) {
    throw new Error(`${label} is missing detailed provenance`);
  }
  if (typeof record.assertions !== 'object' || record.assertions === null || Array.isArray(record.assertions)) {
    throw new Error(`${label} is missing assertion results`);
  }
}

function validateProvenance(record: Record<string, unknown>, manifest: CampaignManifest, thresholds: Thresholds, label: string): void {
  assertRecord(record, label);
  const runnerImage = record.runnerImage as string;
  if (
    record.campaignId !== manifest.campaignId ||
    record.sourceCommit !== manifest.sourceCommit ||
    record.runnerClass !== manifest.runnerClass ||
    getRunnerImageFamily(runnerImage) !== getRunnerImageFamily(manifest.runnerImage) ||
    record.guestImage !== manifest.guestImage ||
    record.evidenceKind !== (manifest.dryRun ? 'dry-run' : 'measured')
  ) {
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
    return (
      Object.keys(values).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => values[key] === value)
    );
  };
  if (
    provenance.compiler !== manifest.provenance.compiler ||
    provenance.awf !== manifest.provenance.awf ||
    provenance.guestImage !== manifest.provenance.guestImage ||
    !exactStringRecord(provenance.runtimeArtifacts, manifest.provenance.runtimeArtifacts) ||
    !exactStringRecord(provenance.workloadVersions, manifest.provenance.workloadVersions)
  ) {
    throw new Error(`${label} has mismatched compiler/runtime/guest/workload provenance`);
  }
  const nvxGuestToolchain = provenance.nvxGuestToolchain;
  if (!manifest.dryRun) {
    const observedGuestTools = provenance.observedGuestTools;
    if (record.success === true && !isObservedGuestTools(observedGuestTools)) {
      throw new Error(`${label} is missing measured guest tool versions`);
    }
    if (observedGuestTools !== undefined && !isObservedGuestTools(observedGuestTools)) {
      throw new Error(`${label} has invalid measured guest tool versions`);
    }
    if (record.runtime === 'nvx') {
      if (!isNvxGuestToolchain(nvxGuestToolchain)) {
        throw new Error(`${label} is missing pinned NVX guest toolchain provenance`);
      }
    } else if (nvxGuestToolchain !== undefined) {
      throw new Error(`${label} has unexpected NVX guest toolchain provenance`);
    }
  } else if (nvxGuestToolchain !== undefined || provenance.observedGuestTools !== undefined) {
    throw new Error(`${label} has unexpected NVX guest toolchain provenance`);
  }
  const assertions = record.assertions as Record<string, unknown>;
  for (const name of thresholds.zeroTolerance) {
    if (typeof assertions[name] !== 'boolean') {
      throw new Error(`${label} is missing zero-tolerance assertion ${name}`);
    }
  }

  function isObservedGuestTools(value: unknown): value is NonNullable<CampaignProvenance['observedGuestTools']> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const tools = value as NonNullable<CampaignProvenance['observedGuestTools']>;
    return typeof tools.node === 'string' && tools.node !== '' && typeof tools.curl === 'string' && tools.curl !== '';
  }

  function isNvxGuestToolchain(value: unknown): value is NonNullable<CampaignProvenance['nvxGuestToolchain']> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const toolchain = value as NonNullable<CampaignProvenance['nvxGuestToolchain']>;
    return (
      /^[0-9a-f]{64}$/i.test(toolchain.layerSha256) &&
      /^[0-9a-f]{64}$/i.test(toolchain.packageInventorySha256) &&
      Array.isArray(toolchain.packages) &&
      toolchain.packages.length > 0 &&
      toolchain.packages.every((entry) => typeof entry === 'string' && entry !== '') &&
      createHash('sha256')
        .update(`${toolchain.packages.join('\n')}\n`)
        .digest('hex') === toolchain.packageInventorySha256 &&
      ['bash-5.2.37-r0', 'curl-8.14.1-r3', 'nodejs-22.23.2-r0', 'npm-11.6.4-r0'].every((version) => toolchain.packages.includes(version)) &&
      toolchain.tools?.node === 'v22.23.2' &&
      toolchain.tools?.npm === '11.6.4' &&
      toolchain.tools?.bash?.includes('5.2.37') === true &&
      toolchain.tools?.curl?.startsWith('curl 8.14.1') === true &&
      ['bash', 'curl', 'node', 'npm'].every(
        (tool) =>
          typeof toolchain.tools?.[tool as 'bash' | 'curl' | 'node' | 'npm'] === 'string' &&
          toolchain.tools[tool as 'bash' | 'curl' | 'node' | 'npm'] !== '',
      )
    );
  }
}

function validateRun(run: RunEvidence, sample: CampaignSample, manifest: CampaignManifest, thresholds: Thresholds): void {
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
  if (typeof run.success !== 'boolean' || typeof run.failureCategory !== 'string' || run.failureCategory === '') {
    throw new Error(`${label} is missing a stable success/failure category`);
  }
  if (run.cachePreparation !== (sample.cache === 'cold' ? 'cold-cache-flushed' : 'warm-cache-primed')) {
    throw new Error(`${label} cache preparation does not match its cache state`);
  }
  const expectedLimits = RESOURCE_PROFILE_LIMITS[sample.resourceProfile];
  if (
    !run.resourceLimits ||
    Object.entries(expectedLimits).some(([key, value]) => run.resourceLimits[key as keyof ResourceLimits] !== value) ||
    typeof run.resourceLimitsEnforced !== 'boolean'
  ) {
    throw new Error(`${label} resource limits do not match its resource profile`);
  }
  const numericMetrics = [
    'artifactPreflightMs',
    'startupMs',
    'firstWorkloadMs',
    'endToEndMs',
    'cleanupMs',
    'peakMemoryMiB',
    'scratchMiB',
    'hostDiskMiB',
    'peakPids',
    'cpuSeconds',
    'apiProxyRequests',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
  ] as const;
  const positiveMetrics = new Set(['startupMs', 'endToEndMs', 'peakMemoryMiB', 'peakPids', 'cpuSeconds']);
  for (const metric of numericMetrics) {
    if (
      !Number.isFinite(run[metric]) ||
      run[metric] < 0 ||
      (run.success && positiveMetrics.has(metric) && run[metric] === 0)
    ) {
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
  if (!run.resourceLimitsEnforced && !run.assertionFailures.includes('resourceLimitsEnforced')) {
    run.assertionFailures.push('resourceLimitsEnforced');
  }
  if (run.success && !run.resourceLimitsEnforced) {
    throw new Error(`${label} resource limits do not match its resource profile`);
  }
  if (!run.success && run.failureCategory === 'success') {
    throw new Error(`${label} has an inconsistent failure category`);
  }
  if (run.success && run.failureCategory !== 'success') {
    throw new Error(`${label} has an inconsistent success category`);
  }
  if (run.rerunOf !== undefined) {
    if (
      typeof run.rerunReason !== 'string' ||
      !INFRASTRUCTURE_FAILURES.has(run.rerunReason) ||
      run.assertionFailures.length > 0 ||
      run.residue.length > 0
    ) {
      throw new Error(`${label} is not eligible for an infrastructure-only rerun`);
    }
  }
}

function validateRecovery(recovery: RecoveryEvidence, sample: RecoverySample, manifest: CampaignManifest, thresholds: Thresholds): void {
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
  if (
    RECOVERY_ASSERTIONS.some((name) => typeof recovery.assertions[name] !== 'boolean') ||
    (recovery.kind === 'stale-recovery' && typeof recovery.assertions.identityCheckedCleanup !== 'boolean')
  ) {
    throw new Error(`${label} is missing readiness or stale-recovery evidence`);
  }
  const failedAssertions = [
    ...RECOVERY_ASSERTIONS.filter((name) => recovery.assertions[name] === false),
    ...(recovery.readinessConfirmed ? [] : ['readinessConfirmed']),
    ...(recovery.terminalObserved ? [] : ['terminalObserved']),
    ...(recovery.kind === 'stale-recovery' && !recovery.managerKilledAfterCleanupRecord ? ['managerKilledAfterCleanupRecord'] : []),
    ...(recovery.kind === 'stale-recovery' && !recovery.workloadAfterRecovery ? ['workloadAfterRecovery'] : []),
    ...(recovery.kind === 'stale-recovery' && recovery.assertions.identityCheckedCleanup === false ? ['identityCheckedCleanup'] : []),
    ...Object.entries(recovery.assertions)
      .filter(([name, passed]) => passed === false && (name !== 'identityCheckedCleanup' || recovery.kind === 'stale-recovery'))
      .map(([name]) => name),
  ];
  for (const name of failedAssertions) {
    if (!recovery.assertionFailures.includes(name)) recovery.assertionFailures.push(name);
  }
  if ((!recovery.success && recovery.failureCategory === 'success') || (recovery.success && recovery.failureCategory !== 'success')) {
    throw new Error(`${label} has an inconsistent success category`);
  }
  if (recovery.rerunOf !== undefined) {
    if (
      typeof recovery.rerunReason !== 'string' ||
      !INFRASTRUCTURE_FAILURES.has(recovery.rerunReason) ||
      recovery.assertionFailures.length > 0 ||
      recovery.residue.length > 0
    ) {
      throw new Error(`${label} is not eligible for an infrastructure-only rerun`);
    }
  }
}

export function aggregateCampaign(manifest: CampaignManifest, artifacts: SampleArtifact[], thresholds: Thresholds): CampaignResults {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !manifest.versions ||
    typeof manifest.versions !== 'object' ||
    Array.isArray(manifest.versions)
  ) {
    throw new Error('unsupported or incomplete campaign manifest');
  }
  if (
    manifest.mode !== 'dry-run' &&
    manifest.mode !== 'canary' &&
    manifest.mode !== 'pilot-100' &&
    manifest.mode !== 'pilot-1000' &&
    manifest.mode !== 'full'
  ) {
    throw new Error('unsupported or incomplete campaign manifest');
  }
  const canonicalManifest = createCampaignManifest(
    {
      campaignId: manifest.campaignId,
      mode: manifest.mode,
      sourceCommit: manifest.sourceCommit,
      runnerClass: manifest.runnerClass,
      runnerImage: manifest.runnerImage,
      guestImage: manifest.guestImage,
    },
    thresholds,
  );
  const samplesMatch = (actual: CampaignSample[] | RecoverySample[], expected: CampaignSample[] | RecoverySample[]): boolean => {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const byId = new Map(actual.map((sample) => [sample?.sampleId, sample]));
    return byId.size === expected.length && expected.every((sample) => isDeepStrictEqual(byId.get(sample.sampleId), sample));
  };
  if (
    manifest.dryRun !== canonicalManifest.dryRun ||
    manifest.canary !== canonicalManifest.canary ||
    manifest.promotionEligible !== canonicalManifest.promotionEligible ||
    manifest.estimatedRunnerMinutes !== canonicalManifest.estimatedRunnerMinutes ||
    !isDeepStrictEqual(manifest.versions, canonicalManifest.versions) ||
    !isDeepStrictEqual(manifest.provenance, canonicalManifest.provenance) ||
    !samplesMatch(manifest.expectedRuns, canonicalManifest.expectedRuns) ||
    !samplesMatch(manifest.expectedRecoveries, canonicalManifest.expectedRecoveries)
  ) {
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
  const runnerImageFamily = getRunnerImageFamily(manifest.runnerImage);
  if (!thresholds.approvedRunnerImageFamilies.includes(runnerImageFamily)) {
    throw new Error(`campaign runner image family ${JSON.stringify(runnerImageFamily)} is not approved`);
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

  if (!manifest.dryRun) {
    const canaryAttempts = [...attempts.values()].flat();
    for (const runtime of ['nvx', 'cloud-hypervisor'] as const) {
      const guestTools = canaryAttempts
        .filter((attempt) => attempt.runtime === runtime && attempt.success)
        .map((attempt) => JSON.stringify(attempt.provenance.observedGuestTools));
      if (new Set(guestTools).size > 1) {
        throw new Error('guest tool versions differ across matched canary samples');
      }
    }
    const nvxToolchains = canaryAttempts
      .filter((attempt) => attempt.runtime === 'nvx')
      .map((attempt) => {
        const toolchain = attempt.provenance.nvxGuestToolchain;
        return JSON.stringify(
          toolchain && {
            packageInventorySha256: toolchain.packageInventorySha256,
            packages: toolchain.packages,
            tools: toolchain.tools,
          },
        );
      });
    if (new Set(nvxToolchains).size > 1) {
      throw new Error('NVX guest toolchain provenance differs across canary samples');
    }
  }

  const primaryRuns: RunEvidence[] = [];
  for (const [sampleId, sampleAttempts] of attempts) {
    const primary = sampleAttempts.filter((attempt) => attempt.rerunOf === undefined);
    if (primary.length !== 1) {
      throw new Error(`sample ${sampleId} must have exactly one original attempt`);
    }
    for (const rerun of sampleAttempts.filter((attempt) => attempt.rerunOf !== undefined)) {
      if (
        rerun.rerunOf !== primary[0].attemptId ||
        primary[0].success ||
        !INFRASTRUCTURE_FAILURES.has(primary[0].failureCategory) ||
        primary[0].assertionFailures.length > 0 ||
        primary[0].residue.length > 0
      ) {
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
      if (
        rerun.rerunOf !== primary[0].attemptId ||
        primary[0].success ||
        !INFRASTRUCTURE_FAILURES.has(primary[0].failureCategory) ||
        primary[0].assertionFailures.length > 0 ||
        primary[0].residue.length > 0
      ) {
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
  const observedSampleIds = [...attempts.keys(), ...recoveryAttempts.keys()].sort();
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
    mode: manifest.mode,
    sourceCommit: manifest.sourceCommit,
    runnerClass: manifest.runnerClass,
    runnerImage: manifest.runnerImage,
    guestImage: manifest.guestImage,
    versions: { ...manifest.versions },
    provenance: structuredClone(manifest.provenance),
    runs: primaryRuns.sort((a, b) => a.sampleId.localeCompare(b.sampleId)),
    recoveries: primaryRecoveries.sort((a, b) => a.sampleId.localeCompare(b.sampleId)),
    attempts: [...attempts.values()].flat().sort((a, b) => a.sampleId.localeCompare(b.sampleId) || a.attemptId.localeCompare(b.attemptId)),
    recoveryAttempts: [...recoveryAttempts.values()]
      .flat()
      .sort((a, b) => a.sampleId.localeCompare(b.sampleId) || a.attemptId.localeCompare(b.attemptId)),
    expectedSampleIds,
    observedSampleIds,
    missingSampleIds,
    unexpectedSampleIds,
    dryRun: manifest.dryRun,
    canary: manifest.canary,
    promotionEligible: manifest.promotionEligible,
    estimatedRunnerMinutes: manifest.estimatedRunnerMinutes,
  };
}

export function isSuccessfulPilot(results: CampaignResults): boolean {
  const resultSampleIds = [...results.runs, ...results.recoveries].map((result) => result.sampleId).sort();
  return (
    (results.mode === 'pilot-100' || results.mode === 'pilot-1000') &&
    !results.dryRun &&
    !results.canary &&
    !results.promotionEligible &&
    results.missingSampleIds.length === 0 &&
    results.unexpectedSampleIds.length === 0 &&
    results.observedSampleIds.length === EXECUTION_SAMPLE_COUNTS[results.mode] &&
    isDeepStrictEqual(resultSampleIds, [...results.observedSampleIds].sort()) &&
    [...results.runs, ...results.recoveries].every(
      (result) => result.success && result.assertionFailures.length === 0 && result.residue.length === 0,
    )
  );
}

export function validateProgressionEvidence(
  current: CampaignManifest,
  predecessor: CampaignManifest,
  results: CampaignResults,
): void {
  const requiredMode = current.mode === 'pilot-1000' ? 'pilot-100' : current.mode === 'full' ? 'pilot-1000' : undefined;
  if (!requiredMode) throw new Error(`campaign mode ${current.mode} does not accept progression evidence`);
  const canonicalPredecessor = createCampaignManifest(
    {
      campaignId: predecessor.campaignId,
      mode: predecessor.mode,
      sourceCommit: predecessor.sourceCommit,
      runnerClass: predecessor.runnerClass,
      runnerImage: predecessor.runnerImage,
      guestImage: predecessor.guestImage,
    },
    loadThresholds(),
  );
  if (!isDeepStrictEqual(predecessor, canonicalPredecessor)) {
    throw new Error('progression manifest is not a canonical immutable campaign tier');
  }
  const currentRunnerImageFamily = getRunnerImageFamily(current.runnerImage);
  const predecessorRunnerImageFamily = getRunnerImageFamily(predecessor.runnerImage);
  if (
    predecessor.mode !== requiredMode ||
    predecessor.campaignId === current.campaignId ||
    predecessor.sourceCommit !== current.sourceCommit ||
    predecessor.runnerClass !== current.runnerClass ||
    predecessorRunnerImageFamily !== currentRunnerImageFamily ||
    predecessor.guestImage !== current.guestImage ||
    !isDeepStrictEqual(predecessor.versions, current.versions) ||
    !isDeepStrictEqual(predecessor.provenance, current.provenance)
  ) {
    throw new Error(`campaign requires a successful ${requiredMode} pilot from the same reviewed source and baseline`);
  }
  const expectedSampleIds = [...predecessor.expectedRuns, ...predecessor.expectedRecoveries]
    .map((sample) => sample.sampleId)
    .sort();
  const invalidFields = [
    results.campaignId !== predecessor.campaignId && 'campaignId',
    results.mode !== predecessor.mode && 'mode',
    results.sourceCommit !== predecessor.sourceCommit && 'sourceCommit',
    results.runnerClass !== predecessor.runnerClass && 'runnerClass',
    results.runnerImage !== predecessor.runnerImage && 'runnerImage',
    [...results.runs, ...results.recoveries].some(
      (result) =>
        result.runnerClass !== predecessor.runnerClass ||
        getRunnerImageFamily(result.runnerImage) !== predecessorRunnerImageFamily,
    ) && 'runnerImageFamily',
    results.guestImage !== predecessor.guestImage && 'guestImage',
    results.estimatedRunnerMinutes !== predecessor.estimatedRunnerMinutes && 'estimatedRunnerMinutes',
    !jsonEqual(results.versions, predecessor.versions) && 'versions',
    !jsonEqual(results.provenance, predecessor.provenance) && 'provenance',
    !isDeepStrictEqual([...results.expectedSampleIds].sort(), expectedSampleIds) && 'expectedSampleIds',
    !isDeepStrictEqual([...results.observedSampleIds].sort(), expectedSampleIds) && 'observedSampleIds',
    !isSuccessfulPilot(results) && 'successfulPilot',
  ].filter((field): field is string => typeof field === 'string');
  if (invalidFields.length > 0) {
    throw new Error(
      `campaign requires complete, successful, immutable ${requiredMode} pilot evidence; invalid ${invalidFields.join(', ')}`,
    );
  }
}

function dryRunAssertions(thresholds: Thresholds): Record<string, boolean> {
  return Object.fromEntries(thresholds.zeroTolerance.map((name) => [name, true]));
}

export function generateDryRunArtifacts(
  manifest: CampaignManifest,
  thresholds: Thresholds,
  identifiers: {
    workflowRunId: string;
    jobId: string;
    workflowAttemptId: string;
  },
): SampleArtifact[] {
  if (!manifest.dryRun) throw new Error('dry-run evidence requires a dry-run campaign manifest');
  const assertions = dryRunAssertions(thresholds);
  const runs: SampleArtifact[] = manifest.expectedRuns.map((sample) => {
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
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
    execFileSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
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
          : results.promotionEligible
            ? 'measured promotion campaign'
            : `**measured ${results.mode} pilot (excluded from promotion thresholds)**`
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
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'), 'utf8')) as Thresholds;
}

function usage(): never {
  throw new Error(
    'usage: nvx-benchmark-campaign plan <manifest.json> <campaign-id> <dry-run|canary|pilot-100|pilot-1000|full> ' +
      '<source-sha> <runner-class> <runner-image> <guest-image> | dry-run <manifest.json> ' +
      '<samples-dir> <workflow-run-id> <job-id> <workflow-attempt> | aggregate ' +
      '<manifest.json> <samples-dir> <results.json> <report.md> | matrix <manifest.json> ' +
      '<matrix.json> | pending <manifest.json> <cell.json> <samples-dir> <allow-infrastructure-retry> ' +
      '<pending.json> | progression <current-manifest.json> <predecessor-manifest.json> <predecessor-results.json>',
  );
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  const thresholds = loadThresholds();
  if (command === 'plan') {
    const [manifestPath, campaignId, mode, sourceCommit, runnerClass, runnerImage, guestImage] = args;
    if (!manifestPath || !campaignId || !mode || !sourceCommit || !runnerClass || !runnerImage || !guestImage) usage();
    if (mode !== 'dry-run' && mode !== 'canary' && mode !== 'pilot-100' && mode !== 'pilot-1000' && mode !== 'full') {
      throw new Error('mode must be dry-run, canary, pilot-100, pilot-1000, or full');
    }
    const manifest = createCampaignManifest({ campaignId, mode, sourceCommit, runnerClass, runnerImage, guestImage }, thresholds);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
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
      workflowRunId,
      jobId,
      workflowAttemptId,
    });
    fs.mkdirSync(samplesDir, { recursive: true });
    for (const artifact of artifacts) {
      const result = artifact.result;
      const file = path.join(samplesDir, `${artifact.kind}-${result.sampleId}-${result.attemptId}.json`);
      fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    }
    const results = aggregateCampaign(manifest, artifacts, thresholds);
    const evaluation = evaluate(results, thresholds);
    fs.writeFileSync(path.join(samplesDir, 'benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(samplesDir, 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(samplesDir, 'report.md'), report(results, thresholds), { mode: 0o600 });
    if (evaluation.recommendation !== 'retain-preview') {
      throw new Error(`dry-run must retain preview; got ${evaluation.recommendation}`);
    }
    process.stdout.write(`Validated ${artifacts.length} dry-run evidence records; evaluator returned retain-preview.\n`);
    return;
  }
  if (command === 'matrix') {
    const [manifestPath, matrixPath] = args;
    if (!manifestPath || !matrixPath) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const cells = createCampaignCells(manifest);
    fs.writeFileSync(matrixPath, `${JSON.stringify({ include: cells }, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`Created ${cells.length} bounded execution cells.\n`);
    return;
  }
  if (command === 'pending') {
    const [manifestPath, cellPath, samplesDir, allowInfrastructureRetry, pendingPath] = args;
    if (!manifestPath || !cellPath || !samplesDir || !allowInfrastructureRetry || !pendingPath) usage();
    if (allowInfrastructureRetry !== 'true' && allowInfrastructureRetry !== 'false') {
      throw new Error('allow-infrastructure-retry must be true or false');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const cell = JSON.parse(fs.readFileSync(cellPath, 'utf8')) as CampaignCell;
    const artifacts = fs.existsSync(samplesDir)
      ? fs
          .readdirSync(samplesDir)
          .filter((file) => /^(run|recovery)-.+\.json$/.test(file))
          .sort()
          .map((file) => JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8')) as SampleArtifact)
      : [];
    const pending = selectPendingCellSamples(manifest, cell, artifacts, allowInfrastructureRetry === 'true');
    fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`Selected ${pending.length} pending samples for ${cell.cellId}.\n`);
    return;
  }
  if (command === 'aggregate') {
    const [manifestPath, samplesDir, resultsPath, reportPath] = args;
    if (!manifestPath || !samplesDir || !resultsPath || !reportPath) usage();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CampaignManifest;
    const artifacts = fs
      .readdirSync(samplesDir)
      .filter((file) => file.endsWith('.json') && !['benchmark-results.json', 'evaluation.json'].includes(file))
      .sort()
      .map((file) => JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8')) as SampleArtifact);
    const results = aggregateCampaign(manifest, artifacts, thresholds);
    const evaluation = evaluate(results, thresholds);
    fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(path.dirname(resultsPath), 'evaluation.json'), `${JSON.stringify(evaluation, null, 2)}\n`, { mode: 0o600 });
    const successfulPilot = isSuccessfulPilot(results);
    fs.writeFileSync(
      path.join(path.dirname(resultsPath), 'campaign-status.json'),
      `${JSON.stringify(
        {
          campaignId: results.campaignId,
          mode: results.mode,
          promotionEligible: results.promotionEligible,
          successfulPilot,
          recommendation: evaluation.recommendation,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(reportPath, report(results, thresholds), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
    if (evaluation.recommendation === 'promote' || successfulPilot) return;
    process.exitCode = 1;
    return;
  }
  if (command === 'progression') {
    const [currentManifestPath, predecessorManifestPath, predecessorResultsPath] = args;
    if (!currentManifestPath || !predecessorManifestPath || !predecessorResultsPath) usage();
    const current = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8')) as CampaignManifest;
    const predecessor = JSON.parse(fs.readFileSync(predecessorManifestPath, 'utf8')) as CampaignManifest;
    const results = JSON.parse(fs.readFileSync(predecessorResultsPath, 'utf8')) as CampaignResults;
    validateProgressionEvidence(current, predecessor, results);
    process.stdout.write(`Validated successful ${predecessor.mode} progression evidence from ${predecessor.campaignId}.\n`);
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
