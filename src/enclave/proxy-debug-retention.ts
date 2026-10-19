import { constants, promises as fs } from 'fs';
import * as path from 'path';
import execa from 'execa';
import {
  hostExecutorVmRunId, readHostExecutorInvocationDiagnostics,
} from './host-executor-journal';
import {
  projectEnclaveProxyResponseDiagnostics, type EnclaveProxyResponseDiagnostics, type EnclaveProxyEvent,
} from './proxy-usage';

const INVOCATION_ID = /^[a-f0-9]{32}$/;
const MAX_INVOCATIONS = 128;
const MAX_EVENTS_BYTES = 256 * 1024;
const MAX_CONTAINER_LOG_BYTES = 32 * 1024;
const SAFE_LOG_EVENTS = new Set([
  'startup', 'startup_complete', 'server_start', 'shutdown', 'request_start',
  'request_complete', 'request_error', 'upstream_error_response', 'upstream_auth_error',
  'request_transform_failed', 'key_validation_error', 'oidc_startup_failed',
  'model_fetch_error', 'model_routing_bootstrap_error',
]);
const SAFE_LEVELS = new Set(['info', 'warn', 'error']);
const SAFE_PROJECTED_LOG_LINE =
  /^source=(stdout|stderr) level=(info|warn|error) event=([a-z_]+)(?: status=([1-5]\d\d))?$/;

/**
 * Read bounded stdout/stderr before compose teardown and immediately discard
 * all free-form fields. A regex scrub of arbitrary log text cannot guarantee
 * credential removal; this closed projection can.
 */
export async function captureEnclaveProxyContainerLog(
  load: () => Promise<{ stdout: string; stderr: string; exitCode: number }> = () =>
    execa('docker', ['logs', '--tail', '200', 'awf-enclave-agent-api-proxy'], {
      reject: false, timeout: 5000, maxBuffer: 128 * 1024,
    }),
): Promise<string> {
  try {
    const result = await load();
    if (result.exitCode !== 0) return 'capture_status=unavailable\n';
    const lines: string[] = [];
    let dropped = 0;
    for (const [source, text] of [['stdout', result.stdout], ['stderr', result.stderr]] as const) {
      for (const line of text.split('\n')) {
        if (!line) continue;
        if (Buffer.byteLength(line) > 4096) { dropped++; continue; }
        let value: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { dropped++; continue; }
          value = parsed as Record<string, unknown>;
        } catch {
          dropped++;
          continue;
        }
        if (!SAFE_LEVELS.has(value.level as string) || !SAFE_LOG_EVENTS.has(value.event as string)) {
          dropped++;
          continue;
        }
        const status = typeof value.status === 'number' && Number.isInteger(value.status)
          && value.status >= 100 && value.status <= 599 ? ` status=${value.status}` : '';
        const projected = `source=${source} level=${value.level} event=${value.event}${status}\n`;
        if (Buffer.byteLength(lines.join('')) + Buffer.byteLength(projected) > MAX_CONTAINER_LOG_BYTES - 128) {
          dropped++;
          continue;
        }
        lines.push(projected);
      }
    }
    return lines.length || dropped
      ? `${lines.join('')}capture_status=captured dropped=${Math.min(dropped, 10000)}\n`
      : 'capture_status=empty\n';
  } catch {
    return 'capture_status=unavailable\n';
  }
}

/**
 * Place only projected numeric evidence into existing protected public
 * invocation debug directories. Raw Docker logs can contain prompts and
 * credentials and must never be copied here.
 */
export async function preservePublicEnclaveProxyDiagnostics(
  run: { runId: string; journalDir?: string },
  debugRoot: string,
  protectedRoot: string,
  evidence: EnclaveProxyResponseDiagnostics,
  sourceEvents: readonly EnclaveProxyEvent[],
  containerLog: string,
): Promise<void> {
  const summary = projectEnclaveProxyResponseDiagnostics(evidence);
  if (sourceEvents.length !== (summary.status === 'captured' ? summary.records : 0)) {
    throw new Error('Enclave proxy events do not match the projected accounting interval');
  }
  const events = sourceEvents.map(value => {
    if (value.schemaVersion !== 1 || (value.origin !== 'local' && value.origin !== 'upstream') ||
        !Number.isInteger(value.status) || value.status < 100 || value.status > 599) {
      throw new Error('Unsafe enclave proxy event');
    }
    return `${JSON.stringify({
      schemaVersion: 1, origin: value.origin, status: value.status,
    })}\n`;
  }).join('');
  if (Buffer.byteLength(events) > MAX_EVENTS_BYTES) {
    throw new Error('Projected enclave proxy evidence exceeds the retention bound');
  }
  const logLines = containerLog.split('\n');
  const trailer = logLines[logLines.length - 2];
  if (Buffer.byteLength(containerLog) > MAX_CONTAINER_LOG_BYTES ||
      logLines[logLines.length - 1] !== '' ||
      !/^(?:capture_status=(?:captured dropped=\d{1,5}|empty|unavailable))$/.test(trailer ?? '') ||
      !logLines.slice(0, -2).every(line => {
        const match = SAFE_PROJECTED_LOG_LINE.exec(line);
        return match && SAFE_LEVELS.has(match[2]) && SAFE_LOG_EVENTS.has(match[3]);
      })) {
    throw new Error('Unsafe enclave proxy container log projection');
  }
  const diagnostics = readHostExecutorInvocationDiagnostics(run);
  let retained = 0;
  for (const item of diagnostics) {
    const snapshot: unknown = JSON.parse(item.contents);
    if (!snapshot || typeof snapshot !== 'object') continue;
    const record = snapshot as Record<string, unknown>;
    if (record.runId !== run.runId || record.executorKind !== 'agent' ||
        typeof record.invocationId !== 'string' || !INVOCATION_ID.test(record.invocationId)) continue;
    const vmId = hostExecutorVmRunId({
      runId: run.runId, entryId: 'agent', invocationId: record.invocationId,
    });
    if (item.name !== `${run.runId}-${vmId}.json`) continue;
    if (++retained > MAX_INVOCATIONS) break;
    const directory = path.join(debugRoot, vmId);
    if (path.dirname(directory) !== debugRoot || path.relative(protectedRoot, directory).startsWith('..')) {
      throw new Error('Public enclave proxy diagnostic destination is outside the protected root');
    }
    let stat;
    try {
      if (await fs.realpath(directory) !== directory) throw new Error('Unsafe public enclave debug directory');
      stat = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) {
      throw new Error('Unsafe public enclave debug directory');
    }
    for (const [name, contents] of [
      ['enclave-proxy-events.jsonl', events],
      ['enclave-proxy-container.log', containerLog],
    ]) {
      const handle = await fs.open(path.join(directory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
}
