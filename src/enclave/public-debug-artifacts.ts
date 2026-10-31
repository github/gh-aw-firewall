import { constants, promises as fs } from 'fs';
import * as path from 'path';
import {
  prepareRootOwnedDebugDirectory, writeAuditFile, type AuditDependencies,
} from '../cloud-hypervisor/diagnostics';
import { projectEnclaveSessionDiagnostics } from '../cloud-hypervisor/enclave-session-diagnostics';
import { PUBLIC_ENCLAVE_CAPTURE_BYTES, redactPublicEnclaveText } from './public-debug-redaction';
export { PUBLIC_ENCLAVE_CAPTURE_BYTES, redactPublicEnclaveText } from './public-debug-redaction';
import {
  projectPublicEnclaveOperationEvent, PUBLIC_ENCLAVE_ERROR_CATEGORIES,
  type PublicEnclaveOperationEvent, type PublicEnclaveOperationFailure, type PublicEnclaveErrorCategory,
} from './public-debug-events';
export const PUBLIC_ENCLAVE_ARTIFACT_NAMES = ['stdout.log', 'stderr.log', 'enclave-session.log', 'diagnostics.json'] as const;
export type PublicEnclaveRuntime = 'docker' | 'cloud-hypervisor';
export type PublicEnclaveStage = 'setup' | 'execution' | 'result' | 'stop' | 'retention' | 'complete';
export type PublicEnclaveFailure = 'setup-failed' | 'execution-exception' | 'workload-exit'
  | 'result-invalid' | 'cancelled' | 'timeout' | 'retention-failed' | 'none';
export type PublicEnclaveStream = {
  status: 'captured' | 'missing' | 'unsafe' | 'oversized' | 'read-failed' | 'not-applicable' | 'unavailable';
  contents?: Buffer;
};
export interface PublicEnclaveArtifactEnvelope {
  version: 1;
  runId: string;
  invocationId: string;
  entryId: string;
  executorKind: 'agent' | 'script';
  runtime: PublicEnclaveRuntime;
  stage: PublicEnclaveStage;
  failure: PublicEnclaveFailure;
  /** Never synthesize a workload exit code from a caught host exception. */
  exitCode: number | null;
  workloadStopped: true;
  /** No workload was created; setup evidence does not imply a synthetic stop. */
  workloadLaunched?: boolean;
  stages?: readonly PublicEnclaveOperationEvent[];
  primaryFailure?: PublicEnclaveOperationFailure;
  cleanupFailure?: PublicEnclaveOperationFailure;
  dockerState?: { running: false; exitCode: number | null; oomKilled: boolean | null };
  vmCountersAvailable?: boolean;
}

/** Read only one fixed, single-link workload file after the workload has stopped. */
export async function readPublicEnclaveFile(
  directory: string, name: 'stdout.log' | 'stderr.log' | 'session.jsonl' | 'enclave-session.log', uid: number, gid?: number,
): Promise<PublicEnclaveStream> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (await fs.realpath(directory) !== directory) return { status: 'unsafe' };
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o7777) !== 0o700) return { status: 'unsafe' };
    handle = await fs.open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (gid !== undefined && stat.gid !== gid)
      || stat.dev !== parent.dev || (stat.mode & 0o7777) !== 0o600) return { status: 'unsafe' };
    if (stat.size > PUBLIC_ENCLAVE_CAPTURE_BYTES) return { status: 'oversized' };
    const contents = Buffer.alloc(PUBLIC_ENCLAVE_CAPTURE_BYTES + 1);
    let total = 0;
    while (total < contents.length) {
      const { bytesRead } = await handle.read(contents, total, contents.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return total > PUBLIC_ENCLAVE_CAPTURE_BYTES ? { status: 'oversized' }
      : { status: 'captured', contents: contents.subarray(0, total) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe' : 'read-failed' };
  } finally { await handle?.close(); }
}

function publicSessionCoverage(session: PublicEnclaveStream): {
  stdout?: Buffer; stderr?: Buffer; copilotDiagnostics: boolean; oversized?: ('stdout' | 'stderr')[];
  captureErrors?: Partial<Record<'stdout' | 'stderr', PublicEnclaveErrorCategory>>;
  captureDrain?: 'unavailable';
} {
  const coverage: ReturnType<typeof publicSessionCoverage> = { copilotDiagnostics: false };
  if (session.status !== 'captured' || !session.contents || session.contents.length > PUBLIC_ENCLAVE_CAPTURE_BYTES) return coverage;
  for (const line of session.contents.toString('utf8').split('\n')) {
    if (!line) continue;
    let value: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(line);
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) continue;
      value = decoded as Record<string, unknown>;
    } catch { continue; }
    if (value.event === 'engine-diagnostics' && value.log && typeof value.log === 'object'
      && 'raw' in value.log && typeof value.log.raw === 'string') coverage.copilotDiagnostics = true;
    if (value.event === 'capture-bound' && value.status === 'oversized'
      && (value.stream === 'stdout' || value.stream === 'stderr')) {
      coverage.oversized ??= [];
      if (!coverage.oversized.includes(value.stream)) coverage.oversized.push(value.stream);
    }
    if (value.event === 'capture-drain' && value.status === 'unavailable') coverage.captureDrain = 'unavailable';
    if (value.event === 'capture-io' && (value.stream === 'stdout' || value.stream === 'stderr')
      && typeof value.category === 'string' && PUBLIC_ENCLAVE_ERROR_CATEGORIES.includes(value.category as PublicEnclaveErrorCategory)) {
      coverage.captureErrors ??= {};
      coverage.captureErrors[value.stream] = value.category as PublicEnclaveErrorCategory;
    }
    if (value.event !== 'engine-result') continue;
    for (const stream of ['stdout', 'stderr'] as const) {
      const source = value[stream];
      if (source && typeof source === 'object' && 'raw' in source && typeof source.raw === 'string') {
        coverage[stream] = Buffer.from(source.raw);
      }
    }
  }
  return coverage;
}

/** Both backends retain through this protected, credential-redacting projection. */
export async function preservePublicEnclaveArtifacts(options: {
  directory: string;
  protectedRoot: string;
  envelope: PublicEnclaveArtifactEnvelope;
  stdout: PublicEnclaveStream;
  stderr: PublicEnclaveStream;
  session: PublicEnclaveStream;
  secrets: readonly string[];
  dependencies: AuditDependencies;
  owner?: { uid: number; gid: number };
}): Promise<void> {
  const { envelope } = options;
  if (![envelope.runId, envelope.invocationId].every(id => /^[a-f0-9]{16,64}$/.test(id))
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(envelope.entryId) || envelope.workloadStopped !== true
    || !['docker', 'cloud-hypervisor'].includes(envelope.runtime)
    || !['agent', 'script'].includes(envelope.executorKind)
    || !['setup', 'execution', 'result', 'stop', 'retention', 'complete'].includes(envelope.stage)
    || !['setup-failed', 'execution-exception', 'workload-exit', 'result-invalid', 'cancelled', 'timeout',
      'retention-failed', 'none'].includes(envelope.failure)
    || (envelope.exitCode !== null && (!Number.isInteger(envelope.exitCode) || envelope.exitCode < -64 || envelope.exitCode > 255))) {
    throw new Error('Invalid public enclave artifact identity or stop proof');
  }
  if (envelope.dockerState && (envelope.dockerState.running !== false
    || (envelope.dockerState.exitCode !== null && (!Number.isInteger(envelope.dockerState.exitCode)
      || envelope.dockerState.exitCode < -64 || envelope.dockerState.exitCode > 255))
    || (envelope.dockerState.oomKilled !== null && typeof envelope.dockerState.oomKilled !== 'boolean'))) {
    throw new Error('Invalid closed Docker backend evidence');
  }
  const prepared = await prepareRootOwnedDebugDirectory(
    options.directory, options.protectedRoot, options.dependencies, options.owner,
  );
  const coverage: ReturnType<typeof publicSessionCoverage> = envelope.executorKind === 'agent'
    ? publicSessionCoverage(options.session) : { copilotDiagnostics: false };
  const captureStatus = publicSessionCoverage(options.stderr);
  coverage.oversized = [...new Set([...(coverage.oversized ?? []), ...(captureStatus.oversized ?? [])])];
  coverage.captureErrors = { ...coverage.captureErrors, ...captureStatus.captureErrors };
  coverage.captureDrain ??= captureStatus.captureDrain;
  const resolved = (name: 'stdout' | 'stderr') => {
    const stream = options[name];
    if (coverage.captureErrors?.[name] || coverage.captureDrain === 'unavailable') {
      return { stream: { status: 'unavailable' as const }, source: 'unavailable' };
    }
    if (coverage.oversized?.includes(name)) {
      return { stream: { status: 'oversized' as const }, source: 'unavailable' };
    }
    if ((stream.status === 'missing' || stream.status === 'unavailable'
      || (stream.status === 'captured' && !stream.contents?.length)) && coverage[name] !== undefined) {
      return { stream: { status: 'captured' as const, contents: coverage[name] }, source: 'agent-session' };
    }
    return {
      stream,
      source: stream.status === 'captured' ? envelope.runtime === 'docker' ? 'workload-file' : 'backend-stream' : 'unavailable',
    };
  };
  const stdout = resolved('stdout');
  const stderr = resolved('stderr');
  for (const [name, stream] of [
    ['stdout.log', stdout.stream], ['stderr.log', stderr.stream], ['enclave-session.log', options.session],
  ] as const) {
    await writeAuditFile(options.dependencies, path.join(prepared.directory, name),
      stream.status === 'captured' && stream.contents ? redactPublicEnclaveText(stream.contents, options.secrets) : '',
      prepared.identity);
  }
  const projection = {
    version: 1, runId: envelope.runId, invocationId: envelope.invocationId,
    entryId: envelope.entryId, executorKind: envelope.executorKind, runtime: envelope.runtime,
    stage: envelope.stage, failure: envelope.failure, exitCode: envelope.exitCode, workloadStopped: true,
    workloadLaunched: envelope.workloadLaunched ?? true,
    stopProof: envelope.workloadLaunched === false ? 'not-launched' : 'verified',
    stages: (envelope.stages ?? []).slice(0, 64).map(projectPublicEnclaveOperationEvent),
    ...(envelope.primaryFailure ? { primaryFailure: projectPublicEnclaveOperationEvent({
      ...envelope.primaryFailure, status: 'failed',
    }) } : {}),
    ...(envelope.cleanupFailure ? { cleanupFailure: projectPublicEnclaveOperationEvent({
      ...envelope.cleanupFailure, status: 'failed',
    }) } : {}),
    streams: { stdout: stdout.stream.status, stderr: stderr.stream.status, session: options.session.status },
    streamCoverage: {
      stdout: { artifactSource: stdout.source, agentSession: coverage.stdout !== undefined ? 'captured' : 'unavailable' },
      stderr: { artifactSource: stderr.source, agentSession: coverage.stderr !== undefined ? 'captured' : 'unavailable' },
      copilotDiagnostics: coverage.copilotDiagnostics ? 'agent-session' : 'unavailable',
      ...(Object.keys(coverage.captureErrors).length ? { captureErrors: coverage.captureErrors } : {}),
      ...(coverage.captureDrain ? { captureDrain: coverage.captureDrain } : {}),
    },
    session: options.session.status === 'captured' && options.session.contents
      ? projectEnclaveSessionDiagnostics(options.session.contents) : { status: options.session.status },
    backendEvidence: {
      dockerInspect: envelope.runtime !== 'docker' ? { status: 'not-applicable' }
        : envelope.dockerState ? {
          status: 'captured', running: false, exitCode: envelope.dockerState.exitCode,
          oomKilled: envelope.dockerState.oomKilled,
        } : { status: 'unavailable' },
      vmCounters: envelope.runtime !== 'cloud-hypervisor' ? { status: 'not-applicable' }
        : envelope.vmCountersAvailable ? { status: 'supplemental', artifact: 'counters.json' }
          : { status: 'unavailable' },
      network: { status: 'unavailable' },
    },
  };
  await writeAuditFile(options.dependencies, path.join(prepared.directory, 'diagnostics.json'),
    `${JSON.stringify(projection)}\n`, prepared.identity);
  const directory = await options.dependencies.open(prepared.directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync?.(); }
  finally { await directory.close(); }
}
