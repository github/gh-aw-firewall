import { isDeepStrictEqual } from 'util';
import type { Thresholds } from '../nvx-promotion-evaluator';
import { getRunnerImageFamily } from '../nvx-runner-baseline';
import { EXECUTION_SAMPLE_COUNTS, INFRASTRUCTURE_FAILURES } from './constants';
import { createCampaignManifest } from './manifest';
import type {
  CampaignManifest,
  CampaignResults,
  CampaignSample,
  RecoveryEvidence,
  RecoverySample,
  RunEvidence,
  SampleArtifact,
} from './manifest';
import { loadThresholds } from './report';
import { validateRecovery, validateRun } from './validate';

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
