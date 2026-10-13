import { createHash } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  CampaignManifest,
  CampaignSample,
  RecoveryEvidence,
  RecoverySample,
  RESOURCE_PROFILE_LIMITS,
  RunEvidence,
  SampleArtifact,
} from './nvx-benchmark-campaign';
import { Thresholds } from './nvx-promotion-evaluator';

interface LifecycleEvidence {
  artifactPreflightStartedMs: number;
  artifactPreflightCompletedMs: number;
  runtimeReadyMs: number;
  firstWorkloadMs: number;
  workloadCompletedMs: number;
  cleanupCompletedMs: number;
  scratchBytes: number;
  hostDiskBytes: number;
  cpuUsageMicros: number;
  guestTools: { node: string; curl: string };
  cachePreparation: 'cold-cache-flushed' | 'warm-cache-primed';
}

interface AssertionEvidence {
  assertions: Record<string, boolean>;
  resourceLimitsEnforced: boolean;
  failureCategory: string;
}

interface TokenUsageRecord {
  event: 'token_usage';
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

type NvxGuestToolchain = NonNullable<
  CampaignManifest['provenance']['nvxGuestToolchain']
>;

export interface AdapterInput {
  manifestPath: string;
  sampleId: string;
  attempt: number;
  command: string[];
  cwd: string;
  outputPath: string;
  lifecyclePath: string;
  assertionsPath: string;
  residuePath: string;
  tokenUsagePath?: string;
  tokenTrackerAuditPath?: string;
  toolchainPath?: string;
  workflowRunId: string;
  jobId: string;
  workflowAttemptId: string;
}

export interface RecoveryAdapterInput {
  manifestPath: string;
  sampleId: string;
  attempt: number;
  command: string[];
  cwd: string;
  outputPath: string;
  measurementPath: string;
  workflowRunId: string;
  jobId: string;
  workflowAttemptId: string;
}

interface RecoveryMeasurement {
  durationMs: number;
  success: boolean;
  failureCategory: string;
  assertions: Record<string, boolean>;
  assertionFailures: string[];
  residue: string[];
  readinessConfirmed: boolean;
  terminalObserved: boolean;
  managerKilledAfterCleanupRecord: boolean;
  workloadAfterRecovery: boolean;
}

interface ProcessMetrics {
  peakMemoryMiB: number;
  peakPids: number;
}

const MIB = 1024 * 1024;
function requireFinite(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    throw new Error(`measured evidence is missing valid ${label}`);
  }
  return value;
}

function requireOrderedLifecycle(value: LifecycleEvidence): void {
  const ordered = [
    value.artifactPreflightStartedMs,
    value.artifactPreflightCompletedMs,
    value.runtimeReadyMs,
    value.firstWorkloadMs,
    value.workloadCompletedMs,
    value.cleanupCompletedMs,
  ];
  ordered.forEach((entry, index) => requireFinite(entry, `lifecycle timestamp ${index}`));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] < ordered[index - 1]) {
      throw new Error('measured lifecycle timestamps are not monotonic');
    }
  }
}

function readJson<T>(file: string, label: string): T {
  if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function parseTokenUsage(
  file: string | undefined,
  auditFile: string | undefined,
  workload: string,
): {
  apiProxyRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
} {
  if (workload !== 'copilot-inference') {
    if (file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '') {
      throw new Error('build-test sample unexpectedly emitted API-proxy token usage');
    }
    if (auditFile && fs.existsSync(auditFile) && fs.readFileSync(auditFile, 'utf8').trim() !== '') {
      throw new Error('build-test sample unexpectedly emitted API-proxy request audit events');
    }
    return { apiProxyRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  }
  if (!file || !fs.existsSync(file)) throw new Error('missing Copilot API-proxy token usage');
  if (!auditFile || !fs.existsSync(auditFile)) {
    throw new Error('missing Copilot API-proxy request audit');
  }
  const apiProxyRequests = fs.readFileSync(auditFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const record = JSON.parse(line) as { event?: unknown };
      if (typeof record.event !== 'string') {
        throw new Error(`invalid API-proxy audit event at line ${index + 1}`);
      }
      return record.event === 'TRACK_START' || record.event === 'WS_TRACK_START';
    })
    .filter(Boolean)
    .length;
  if (apiProxyRequests === 0) throw new Error('Copilot sample emitted no API-proxy request starts');
  const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    const record = JSON.parse(line) as Partial<TokenUsageRecord>;
    if (record.event !== 'token_usage') throw new Error(`invalid token usage event at line ${index + 1}`);
    return {
      event: record.event,
      input_tokens: requireFinite(record.input_tokens, 'input_tokens'),
      output_tokens: requireFinite(record.output_tokens, 'output_tokens'),
      cache_read_tokens: requireFinite(record.cache_read_tokens, 'cache_read_tokens'),
    };
  });
  return {
    apiProxyRequests,
    inputTokens: records.reduce((sum, record) => sum + record.input_tokens, 0),
    outputTokens: records.reduce((sum, record) => sum + record.output_tokens, 0),
    cacheReadTokens: records.reduce((sum, record) => sum + record.cache_read_tokens, 0),
  };
}

function stableAttemptId(sampleId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer');
  return createHash('sha256').update(`${sampleId}\0${attempt}`).digest('hex').slice(0, 24);
}

export function buildMeasuredArtifact(
  manifest: CampaignManifest,
  sample: CampaignSample,
  input: Omit<AdapterInput, 'manifestPath' | 'sampleId' | 'command' | 'cwd' | 'outputPath'>,
  lifecycle: LifecycleEvidence,
  assertionEvidence: AssertionEvidence,
  residue: string[],
  metrics: ProcessMetrics,
  exitCode: number,
  thresholds: Thresholds,
): SampleArtifact {
  if (manifest.dryRun) {
    throw new Error('the matched-runtime adapter rejects synthetic dry-run manifests');
  }
  requireOrderedLifecycle(lifecycle);
  const expectedCachePreparation =
    sample.cache === 'cold' ? 'cold-cache-flushed' : 'warm-cache-primed';
  if (lifecycle.cachePreparation !== expectedCachePreparation) {
    throw new Error('measured cache preparation does not match the sample cache state');
  }
  if (!Array.isArray(residue) || residue.some((item) => typeof item !== 'string')) {
    throw new Error('residue evidence must be a string array');
  }
  if (!assertionEvidence || typeof assertionEvidence.assertions !== 'object') {
    throw new Error('missing assertion evidence');
  }
  for (const assertion of thresholds.zeroTolerance) {
    if (typeof assertionEvidence.assertions[assertion] !== 'boolean') {
      throw new Error(`missing zero-tolerance assertion ${assertion}`);
    }
  }
  if (assertionEvidence.resourceLimitsEnforced !== true) {
    throw new Error('resource limits were not proven enforced');
  }
  const tokens = parseTokenUsage(
    input.tokenUsagePath,
    input.tokenTrackerAuditPath,
    sample.workload,
  );
  const assertionFailures = Object.entries(assertionEvidence.assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const success = exitCode === 0 && assertionFailures.length === 0 && residue.length === 0;
  const failureCategory = assertionEvidence.failureCategory;
  if (!failureCategory || (success && failureCategory !== 'success') ||
    (!success && failureCategory === 'success')) {
    throw new Error('measured success and failure category are inconsistent');
  }
  const provenance = structuredClone(manifest.provenance);
  if (sample.runtime === 'nvx') {
    if (!input.toolchainPath) throw new Error('missing NVX guest toolchain provenance');
    const toolchain = readJson<NvxGuestToolchain>(input.toolchainPath, 'NVX guest toolchain');
    if (!/^[0-9a-f]{64}$/i.test(toolchain.layerSha256) ||
      !/^[0-9a-f]{64}$/i.test(toolchain.packageInventorySha256) ||
      !Array.isArray(toolchain.packages) || toolchain.packages.length === 0 ||
      !toolchain.packages.every((entry) => typeof entry === 'string' && entry !== '') ||
      !['bash', 'curl', 'node', 'npm'].every((name) =>
        typeof toolchain.tools?.[name as keyof NvxGuestToolchain['tools']] === 'string' &&
        toolchain.tools[name as keyof NvxGuestToolchain['tools']] !== '') ||
      createHash('sha256').update(`${toolchain.packages.join('\n')}\n`).digest('hex') !==
        toolchain.packageInventorySha256 ||
      ![
        'bash-5.2.37-r0',
        'curl-8.14.1-r3',
        'nodejs-22.23.2-r0',
        'npm-11.6.4-r0',
      ].every((version) => toolchain.packages.includes(version)) ||
      toolchain.tools.node !== 'v22.23.2' ||
      toolchain.tools.npm !== '11.6.4' ||
      !toolchain.tools.bash.includes('5.2.37') ||
      !toolchain.tools.curl.startsWith('curl 8.14.1')) {
      throw new Error('invalid NVX guest toolchain provenance');
    }
    provenance.nvxGuestToolchain = toolchain;
  } else if (input.toolchainPath) {
    throw new Error('Cloud Hypervisor sample unexpectedly included NVX guest toolchain provenance');
  }
  if (!lifecycle.guestTools ||
    typeof lifecycle.guestTools.node !== 'string' || lifecycle.guestTools.node === '' ||
    typeof lifecycle.guestTools.curl !== 'string' || lifecycle.guestTools.curl === '') {
    throw new Error('missing measured guest tool versions');
  }
  provenance.observedGuestTools = lifecycle.guestTools;
  const result: RunEvidence = {
    ...sample,
    campaignId: manifest.campaignId,
    attemptId: stableAttemptId(sample.sampleId, input.attempt),
    workflowRunId: input.workflowRunId,
    jobId: input.jobId,
    workflowAttemptId: input.workflowAttemptId,
    success,
    failureCategory,
    artifactPreflightMs: lifecycle.artifactPreflightCompletedMs - lifecycle.artifactPreflightStartedMs,
    startupMs: lifecycle.runtimeReadyMs - lifecycle.artifactPreflightCompletedMs,
    firstWorkloadMs: lifecycle.firstWorkloadMs - lifecycle.runtimeReadyMs,
    endToEndMs: lifecycle.workloadCompletedMs - lifecycle.artifactPreflightStartedMs,
    cleanupMs: lifecycle.cleanupCompletedMs - lifecycle.workloadCompletedMs,
    peakMemoryMiB: requireFinite(metrics.peakMemoryMiB, 'peakMemoryMiB', true),
    scratchMiB: requireFinite(lifecycle.scratchBytes, 'scratchBytes') / MIB,
    hostDiskMiB: requireFinite(lifecycle.hostDiskBytes, 'hostDiskBytes') / MIB,
    peakPids: requireFinite(metrics.peakPids, 'peakPids', true),
    cpuSeconds: requireFinite(lifecycle.cpuUsageMicros, 'cpuUsageMicros', true) / 1_000_000,
    ...tokens,
    assertionFailures,
    residue,
    assertions: assertionEvidence.assertions,
    cachePreparation: lifecycle.cachePreparation,
    resourceLimits: { ...RESOURCE_PROFILE_LIMITS[sample.resourceProfile] },
    resourceLimitsEnforced: true,
    sourceCommit: manifest.sourceCommit,
    runnerClass: manifest.runnerClass,
    runnerImage: manifest.runnerImage,
    guestImage: manifest.guestImage,
    versions: { ...manifest.versions },
    provenance,
    evidenceKind: 'measured',
  };
  return { kind: 'run', result };
}

export function buildMeasuredRecoveryArtifact(
  manifest: CampaignManifest,
  sample: RecoverySample,
  input: Pick<
    RecoveryAdapterInput,
    'attempt' | 'workflowRunId' | 'jobId' | 'workflowAttemptId'
  >,
  measurement: RecoveryMeasurement,
  thresholds: Thresholds,
): SampleArtifact {
  if (manifest.dryRun) {
    throw new Error('the matched-runtime adapter rejects synthetic dry-run manifests');
  }
  requireFinite(measurement.durationMs, 'recovery durationMs', true);
  if (typeof measurement.success !== 'boolean' || !measurement.failureCategory ||
    !Array.isArray(measurement.assertionFailures) || !Array.isArray(measurement.residue) ||
    measurement.residue.some((item) => typeof item !== 'string')) {
    throw new Error('measured recovery evidence is incomplete');
  }
  if (!measurement.assertions || typeof measurement.assertions !== 'object') {
    throw new Error('measured recovery assertions are missing');
  }
  const required = [
    ...thresholds.zeroTolerance,
    'processTreeGone',
    'mountsRestored',
    'namespacesRestored',
    'cgroupsRestored',
    'runDirectoryRemoved',
    'scratchRemoved',
    'snapshotRemoved',
    'cleanupRecordRemoved',
    'kvmAclRestored',
    ...(sample.kind === 'stale-recovery' ? ['identityCheckedCleanup'] : []),
  ];
  for (const assertion of required) {
    if (typeof measurement.assertions[assertion] !== 'boolean') {
      throw new Error(`missing recovery assertion ${assertion}`);
    }
  }
  for (const field of [
    'readinessConfirmed',
    'terminalObserved',
    'managerKilledAfterCleanupRecord',
    'workloadAfterRecovery',
  ] as const) {
    if (typeof measurement[field] !== 'boolean') {
      throw new Error(`missing recovery evidence ${field}`);
    }
  }
  const failed = Object.entries(measurement.assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  for (const name of failed) {
    if (!measurement.assertionFailures.includes(name)) measurement.assertionFailures.push(name);
  }
  const success = measurement.success && measurement.assertionFailures.length === 0 &&
    measurement.residue.length === 0 && measurement.readinessConfirmed &&
    measurement.terminalObserved &&
    (sample.kind !== 'stale-recovery' ||
      (measurement.managerKilledAfterCleanupRecord && measurement.workloadAfterRecovery));
  if ((success && measurement.failureCategory !== 'success') ||
    (!success && measurement.failureCategory === 'success')) {
    throw new Error('measured recovery success and failure category are inconsistent');
  }
  const result: RecoveryEvidence = {
    ...sample,
    campaignId: manifest.campaignId,
    attemptId: stableAttemptId(sample.sampleId, input.attempt),
    workflowRunId: input.workflowRunId,
    jobId: input.jobId,
    workflowAttemptId: input.workflowAttemptId,
    success,
    failureCategory: measurement.failureCategory,
    durationMs: measurement.durationMs,
    assertions: measurement.assertions,
    assertionFailures: measurement.assertionFailures,
    residue: measurement.residue,
    readinessConfirmed: measurement.readinessConfirmed,
    terminalObserved: measurement.terminalObserved,
    managerKilledAfterCleanupRecord: measurement.managerKilledAfterCleanupRecord,
    workloadAfterRecovery: measurement.workloadAfterRecovery,
    sourceCommit: manifest.sourceCommit,
    runnerClass: manifest.runnerClass,
    runnerImage: manifest.runnerImage,
    guestImage: manifest.guestImage,
    versions: { ...manifest.versions },
    provenance: structuredClone(manifest.provenance),
    evidenceKind: 'measured',
  };
  return { kind: 'recovery', result };
}

function readProcessTreeMetrics(rootPid: number): Omit<ProcessMetrics, 'cpuSeconds'> {
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        const parent = Number(fields[1]);
        if (descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid);
          changed = true;
        }
      } catch {
        // The process exited between discovery and reading.
      }
    }
  }
  let rssKiB = 0;
  for (const pid of descendants) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      rssKiB += rss ? Number(rss[1]) : 0;
    } catch {
      // The process exited between discovery and reading.
    }
  }
  return {
    peakMemoryMiB: rssKiB / 1024,
    peakPids: descendants.size,
  };
}

export async function executeMeasuredSample(input: AdapterInput): Promise<SampleArtifact> {
  if (process.platform !== 'linux' || !fs.existsSync('/proc')) {
    throw new Error('real matched-runtime measurement requires Linux procfs');
  }
  const manifest = readJson<CampaignManifest>(input.manifestPath, 'campaign manifest');
  const sample = manifest.expectedRuns.find((candidate) => candidate.sampleId === input.sampleId);
  if (!sample) throw new Error(`sample ${input.sampleId} is not in the campaign manifest`);
  const thresholds = readJson<Thresholds>(
    path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'),
    'promotion thresholds',
  );
  if (input.command.length === 0 || input.command.some((part) => part === '')) {
    throw new Error('sample command must be a non-empty argv array');
  }
  const child = spawn(input.command[0], input.command.slice(1), {
    cwd: input.cwd,
    env: {
      ...process.env,
      AWF_BENCHMARK_EVENTS: input.lifecyclePath,
      AWF_BENCHMARK_ASSERTIONS: input.assertionsPath,
      AWF_BENCHMARK_RESIDUE: input.residuePath,
    },
    stdio: 'inherit',
  });
  if (!child.pid) throw new Error('sample command did not start');
  let peakMemoryMiB = 0;
  let peakPids = 0;
  const timer = setInterval(() => {
    const current = readProcessTreeMetrics(child.pid!);
    peakMemoryMiB = Math.max(peakMemoryMiB, current.peakMemoryMiB);
    peakPids = Math.max(peakPids, current.peakPids);
  }, 100);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`sample command terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  }).finally(() => clearInterval(timer));
  const final = readProcessTreeMetrics(child.pid);
  peakMemoryMiB = Math.max(peakMemoryMiB, final.peakMemoryMiB);
  peakPids = Math.max(peakPids, final.peakPids);
  const artifact = buildMeasuredArtifact(
    manifest,
    sample,
    input,
    readJson<LifecycleEvidence>(input.lifecyclePath, 'lifecycle evidence'),
    readJson<AssertionEvidence>(input.assertionsPath, 'assertion evidence'),
    readJson<string[]>(input.residuePath, 'residue evidence'),
    { peakMemoryMiB, peakPids },
    exitCode,
    thresholds,
  );
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return artifact;
}

export async function executeMeasuredRecovery(
  input: RecoveryAdapterInput,
): Promise<SampleArtifact> {
  const manifest = readJson<CampaignManifest>(input.manifestPath, 'campaign manifest');
  const sample = manifest.expectedRecoveries.find((candidate) => candidate.sampleId === input.sampleId);
  if (!sample) throw new Error(`recovery ${input.sampleId} is not in the campaign manifest`);
  if (input.command.length === 0 || input.command.some((part) => part === '')) {
    throw new Error('recovery command must be a non-empty argv array');
  }
  const result = spawn(input.command[0], input.command.slice(1), {
    cwd: input.cwd,
    env: {
      ...process.env,
      AWF_BENCHMARK_RECOVERY_EVIDENCE: input.measurementPath,
    },
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    result.once('error', reject);
    result.once('exit', (code, signal) => {
      if (signal) reject(new Error(`recovery command terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  const thresholds = readJson<Thresholds>(
    path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'),
    'promotion thresholds',
  );
  const measurement = readJson<RecoveryMeasurement>(
    input.measurementPath,
    'recovery measurement',
  );
  if ((exitCode === 0) !== measurement.success) {
    throw new Error('recovery command exit status contradicts measured success');
  }
  const artifact = buildMeasuredRecoveryArtifact(
    manifest,
    sample,
    input,
    measurement,
    thresholds,
  );
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return artifact;
}

function main(): void {
  const [kindOrPath, maybePath] = process.argv.slice(2);
  const kind = maybePath ? kindOrPath : 'run';
  const inputPath = maybePath ?? kindOrPath;
  if (!inputPath || (kind !== 'run' && kind !== 'recovery')) {
    throw new Error(
      'usage: nvx-matched-runtime-adapter [run|recovery] <input.json>',
    );
  }
  if (kind === 'recovery') {
    const input = readJson<RecoveryAdapterInput>(inputPath, 'recovery adapter input');
    executeMeasuredRecovery(input)
      .then((artifact) => {
        if (!artifact.result.success) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
    return;
  }
  const input = readJson<AdapterInput>(inputPath, 'adapter input');
  executeMeasuredSample(input)
    .then((artifact) => {
      if (!artifact.result.success) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

if (require.main === module) main();

/** @internal Exposed for focused evidence contract tests. */
export const matchedRuntimeAdapterTestHelpers = {
  parseTokenUsage,
  stableAttemptId,
};
