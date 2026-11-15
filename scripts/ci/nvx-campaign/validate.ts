import { createHash } from 'crypto';
import type { Thresholds } from '../nvx-promotion-evaluator';
import { getRunnerImageFamily } from '../nvx-runner-baseline';
import { INFRASTRUCTURE_FAILURES, RESOURCE_PROFILE_LIMITS } from './constants';
import type {
  CampaignManifest,
  CampaignProvenance,
  CampaignSample,
  RecoveryEvidence,
  RecoverySample,
  ResourceLimits,
  RunEvidence,
} from './manifest';

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

export function assertRecord(record: Record<string, unknown>, label: string): void {
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

export function validateProvenance(record: Record<string, unknown>, manifest: CampaignManifest, thresholds: Thresholds, label: string): void {
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

export function validateRun(run: RunEvidence, sample: CampaignSample, manifest: CampaignManifest, thresholds: Thresholds): void {
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

export function validateRecovery(recovery: RecoveryEvidence, sample: RecoverySample, manifest: CampaignManifest, thresholds: Thresholds): void {
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
