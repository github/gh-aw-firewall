import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { BenchmarkResults, RecoveryResult, RunResult, Thresholds } from '../nvx-promotion-evaluator';
import { getRunnerImageFamily } from '../nvx-runner-baseline';
import { EXECUTION_SAMPLE_COUNTS, INFRASTRUCTURE_FAILURES } from './constants';
import { loadThresholds } from './report';
import { validateRecovery, validateRun } from './validate';

export { RESOURCE_PROFILE_LIMITS } from './constants';

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

const RUNNER_MINUTES_PER_SAMPLE = 10;
const MAX_CELL_SAMPLES = 20;

function stableId(campaignId: string, parts: string[]): string {
  return createHash('sha256')
    .update([campaignId, ...parts].join('\0'))
    .digest('hex')
    .slice(0, 24);
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
