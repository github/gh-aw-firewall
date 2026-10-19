import execa from 'execa';
import { getLocalDockerEnv } from '../docker-host';
import { ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME } from '../constants';
import { persistHostExecutorProxyDebugDiagnostics } from './host-executor-journal';
import {
  projectEnclaveProxyResponseDiagnostics, type EnclaveProxyResponseDiagnostics, type EnclaveProxyEvent,
} from './proxy-usage';

const MAX_EVENTS_BYTES = 256 * 1024;
const MAX_CONTAINER_LOG_BYTES = 32 * 1024;
const SAFE_LOG_EVENTS = new Set([
  'startup', 'startup_complete', 'server_start', 'shutdown', 'request_start',
  'request_complete', 'request_error', 'upstream_error_response', 'upstream_auth_error',
  'request_transform_failed', 'key_validation_error', 'oidc_startup_failed',
  'model_fetch_error', 'model_routing_bootstrap_error',
  'enclave_model_budget_rejected', 'rate_limited', 'request_validation_failed', 'model_fallback_exhausted',
  'enclave_model_capability_missing', 'enclave_model_capability_scheme', 'enclave_model_capability_format',
  'enclave_model_capability_signature', 'enclave_model_capability_claims', 'enclave_model_capability_claims_changed',
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
    execa('docker', ['logs', '--tail', '200', ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME], {
      env: getLocalDockerEnv(), reject: false, timeout: 5000, maxBuffer: 128 * 1024,
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
 * Persist one protected run-cumulative projection even before the first
 * invocation. Raw Docker logs must never be copied here.
 */
export async function preservePublicEnclaveProxyDiagnostics(
  run: { runId: string; journalDir?: string },
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
  persistHostExecutorProxyDebugDiagnostics(run, sourceEvents, containerLog);
}
