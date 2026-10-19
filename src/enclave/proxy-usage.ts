import { constants, promises as fs } from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';

export const ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES = 1024 * 1024;
export const ENCLAVE_PROXY_USAGE_MAX_RECORDS = 4096;
export const ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES = 16 * 1024;
export const ENCLAVE_PROXY_USAGE_RESULTS = [
  'ok', 'no_usage', 'skip_status', 'unsupported_accounting', 'skip_encoding',
] as const;
export const ENCLAVE_PROXY_USAGE_TOKEN_FIELDS = [
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
] as const;
export type EnclaveProxyUsageStatus =
  | 'captured' | 'empty' | 'missing' | 'unsafe' | 'oversized' | 'record-limit'
  | 'malformed' | 'read-failed' | 'not-drained' | 'not-applicable';
interface Source {
  status: EnclaveProxyUsageStatus;
  records?: number;
}
export interface EnclaveProxyUsage {
  scope: 'run-cumulative';
  requests: Source & {
    trackedResponses?: number;
    websocketSessions?: number;
    statuses?: Record<string, number>;
    results?: Record<string, number>;
  };
  tokens: Source & {
    usageRecords?: number;
    totals?: Record<(typeof ENCLAVE_PROXY_USAGE_TOKEN_FIELDS)[number], number>;
  };
}

export interface EnclaveProxyResponseDiagnostics {
  scope: 'run-cumulative';
  status: EnclaveProxyUsageStatus;
  records?: number;
  local?: Record<string, number>;
  upstream?: Record<string, number>;
}

export interface EnclaveProxyEvent {
  schemaVersion: 1;
  origin: 'local' | 'upstream';
  status: number;
}

export function projectEnclaveProxyResponseDiagnostics(value: unknown): EnclaveProxyResponseDiagnostics {
  const source = record(value);
  const states: EnclaveProxyUsageStatus[] = [
    'empty', 'missing', 'unsafe', 'oversized', 'record-limit', 'malformed', 'read-failed',
    'not-drained', 'not-applicable',
  ];
  if (states.includes(source?.status as EnclaveProxyUsageStatus)) {
    return { scope: 'run-cumulative', status: source!.status as EnclaveProxyUsageStatus };
  }
  if (source?.status !== 'captured' || !count(source.records) ||
      source.records < 1 || source.records > ENCLAVE_PROXY_USAGE_MAX_RECORDS) {
    return { scope: 'run-cumulative', status: 'malformed' };
  }
  const local = record(source.local);
  const upstream = record(source.upstream);
  if (!local || !upstream) return { scope: 'run-cumulative', status: 'malformed' };
  const safeLocal: Record<string, number> = {};
  const safeUpstream: Record<string, number> = {};
  for (const [input, output] of [[local, safeLocal], [upstream, safeUpstream]] as const) {
    for (const [key, value] of Object.entries(input)) {
      if (!/^[1-5][0-9]{2}$/.test(key) || !count(value) || value < 1 ||
          value > source.records) return { scope: 'run-cumulative', status: 'malformed' };
      output[key] = value;
    }
  }
  if (Object.values(safeLocal).concat(Object.values(safeUpstream))
    .reduce((sum, value) => sum + value, 0) !== source.records) {
    return { scope: 'run-cumulative', status: 'malformed' };
  }
  return { scope: 'run-cumulative', status: 'captured', records: source.records,
    local: safeLocal, upstream: safeUpstream };
}

/** Never retain raw proxy diagnostics: project only numeric HTTP status and fixed origin. */
export async function readEnclaveProxyResponseDiagnostics(
  directory: string,
  uid = Number(getSafeHostUid()),
  gid = Number(getSafeHostGid()),
  events?: EnclaveProxyEvent[],
): Promise<EnclaveProxyResponseDiagnostics> {
  const unavailable = (status: EnclaveProxyUsageStatus): EnclaveProxyResponseDiagnostics =>
    ({ scope: 'run-cumulative', status });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory ||
        await fs.realpath(directory) !== directory) return unavailable('unsafe');
    const dir = await fs.lstat(directory);
    if (!dir.isDirectory() || dir.uid !== uid || dir.gid !== gid ||
        (dir.mode & 0o7777) !== 0o700) return unavailable('unsafe');
    handle = await fs.open(path.join(directory, 'enclave-proxy-events.jsonl'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await handle.stat();
    if (!file.isFile() || file.nlink !== 1 || file.dev !== dir.dev ||
        file.uid !== uid || file.gid !== gid || (file.mode & 0o7777) !== 0o600) return unavailable('unsafe');
    if (file.size > ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES) return unavailable('oversized');
    const bytes = Buffer.alloc(ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES) return unavailable('oversized');
    if (!length) return unavailable('empty');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    if (!text.endsWith('\n')) return unavailable('malformed');
    const local: Record<string, number> = {};
    const upstream: Record<string, number> = {};
    let records = 0;
    for (const line of text.split('\n').slice(0, -1)) {
      if (++records > ENCLAVE_PROXY_USAGE_MAX_RECORDS) return unavailable('record-limit');
      if (Buffer.byteLength(line) > ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES) return unavailable('oversized');
      const value = record(JSON.parse(line));
      if (!value || value.schemaVersion !== 1 || !count(value.status) ||
          value.status < 100 || value.status > 599 ||
          (value.origin !== 'local' && value.origin !== 'upstream')) return unavailable('malformed');
      add(value.origin === 'local' ? local : upstream, String(value.status), 1);
      events?.push({ schemaVersion: 1, origin: value.origin, status: value.status });
    }

    return projectEnclaveProxyResponseDiagnostics({
      scope: 'run-cumulative', status: 'captured', records, local, upstream,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailable(code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe'
      : error instanceof SyntaxError || error instanceof TypeError ? 'malformed' : 'read-failed');
  } finally {
    await handle?.close();
  }
}

export async function readEnclaveProxyEventEvidence(
  directory: string,
): Promise<{ diagnostics: EnclaveProxyResponseDiagnostics; events: EnclaveProxyEvent[] }> {
  const events: EnclaveProxyEvent[] = [];
  const diagnostics = await readEnclaveProxyResponseDiagnostics(
    directory, Number(getSafeHostUid()), Number(getSafeHostGid()), events,
  );
  return { diagnostics, events: diagnostics.status === 'captured' ? events : [] };
}

export function unavailableEnclaveProxyUsage(status: EnclaveProxyUsageStatus): EnclaveProxyUsage {
  return { scope: 'run-cumulative', requests: { status }, tokens: { status } };
}

/** Re-project even host-supplied evidence before placing it in a durable journal. */
export function projectEnclaveProxyUsage(value: unknown): EnclaveProxyUsage {
  const source = record(value);
  const result = unavailableEnclaveProxyUsage('malformed');
  const states: EnclaveProxyUsageStatus[] = [
    'empty', 'missing', 'unsafe', 'oversized', 'record-limit', 'malformed', 'read-failed',
    'not-drained', 'not-applicable',
  ];
  for (const kind of ['requests', 'tokens'] as const) {
    const item = record(source?.[kind]);
    if (!item) continue;
    if (states.includes(item.status as EnclaveProxyUsageStatus)) {
      result[kind] = { status: item.status as EnclaveProxyUsageStatus };
      continue;
    }
    if (item.status !== 'captured' || !count(item.records) || item.records < 1 ||
        item.records > ENCLAVE_PROXY_USAGE_MAX_RECORDS) continue;
    if (kind === 'tokens') {
      const totals = record(item.totals);
      if (item.usageRecords !== item.records ||
          !ENCLAVE_PROXY_USAGE_TOKEN_FIELDS.every(key => count(totals?.[key]))) continue;
      result.tokens = {
        status: 'captured', records: item.records, usageRecords: item.usageRecords,
        totals: Object.fromEntries(ENCLAVE_PROXY_USAGE_TOKEN_FIELDS.map(key => [key, totals![key]])) as
          NonNullable<EnclaveProxyUsage['tokens']['totals']>,
      };
    } else {
      const statuses = record(item.statuses);
      const results = record(item.results);
      if (!count(item.trackedResponses) || item.trackedResponses > item.records ||
          !count(item.websocketSessions) || item.websocketSessions > item.records - item.trackedResponses ||
          !statuses || !results) continue;
      const safeStatuses: Record<string, number> = {};
      const safeResults: Record<string, number> = {};
      for (let status = 100; status <= 599; status++) {
        const number = statuses[String(status)];
        if (count(number) && number <= item.records) safeStatuses[String(status)] = number;
      }
      for (const key of ENCLAVE_PROXY_USAGE_RESULTS) {
        if (count(results[key]) && results[key] <= item.records) safeResults[key] = results[key];
      }
      if (Object.values(safeStatuses).reduce((sum, value) => sum + value, 0) !== item.trackedResponses ||
          Object.values(safeResults).reduce((sum, value) => sum + value, 0) > item.records) continue;
      result.requests = {
        status: 'captured', records: item.records, trackedResponses: item.trackedResponses,
        websocketSessions: item.websocketSessions, statuses: safeStatuses, results: safeResults,
      };
    }
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function add(target: Record<string, number>, key: string, value: number): void {
  const next = (target[key] ?? 0) + value;
  if (!Number.isSafeInteger(next)) throw new Error('Accounting overflow');
  target[key] = next;
}

function project(bytes: Buffer, tokens: boolean): EnclaveProxyUsage['tokens'] | EnclaveProxyUsage['requests'] {
  if (!bytes.length) return { status: 'empty', records: 0 };
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const statuses: Record<string, number> = {};
  const results: Record<string, number> = {};
  let records = 0;
  let trackedResponses = 0;
  let websocketSessions = 0;
  let usageRecords = 0;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // An unfinished append is not evidence of a complete accounting interval.
    if (!text.endsWith('\n')) return { status: 'malformed' };
    for (const line of text.split('\n').slice(0, -1)) {
      if (++records > ENCLAVE_PROXY_USAGE_MAX_RECORDS) return { status: 'record-limit' };
      if (Buffer.byteLength(line) > ENCLAVE_PROXY_USAGE_MAX_LINE_BYTES) return { status: 'oversized' };
      const value = record(JSON.parse(line));
      if (!value) return { status: 'malformed' };
      if (tokens) {
        if (value.event !== 'token_usage' ||
            !ENCLAVE_PROXY_USAGE_TOKEN_FIELDS.every(key => count(value[key]))) return { status: 'malformed' };
        for (const key of ENCLAVE_PROXY_USAGE_TOKEN_FIELDS) add(totals, key, value[key] as number);
        usageRecords += 1;
      } else if (value.event === 'TRACK_START') {
        if (!count(value.status) || value.status < 100 || value.status > 599) return { status: 'malformed' };
        trackedResponses += 1;
        add(statuses, String(value.status), 1);
      } else if (value.event === 'WS_TRACK_START') {
        websocketSessions += 1;
      } else if (value.event === 'TRACK_SKIP_ENCODING') {
        add(results, 'skip_encoding', 1);
      } else if (value.event === 'TRACK_END' || value.event === 'WS_TRACK_END') {
        if (!ENCLAVE_PROXY_USAGE_RESULTS.includes(value.result as typeof ENCLAVE_PROXY_USAGE_RESULTS[number])) {
          return { status: 'malformed' };
        }
        add(results, value.result as string, 1);
      } else return { status: 'malformed' };
    }
    return tokens
      ? { status: 'captured', records, usageRecords, totals }
      : { status: 'captured', records, trackedResponses, websocketSessions, statuses, results };
  } catch {
    return { status: 'malformed' };
  }
}

/**
 * Reads exactly two dedicated-proxy files, never stdout, payload diagnostics,
 * arbitrary filenames or request IDs. Called after host admissions have drained.
 * TRACK_START counts upstream responses, not every attempted client request.
 */
export async function readEnclaveProxyUsage(
  directory: string,
  uid = Number(getSafeHostUid()),
  gid = Number(getSafeHostGid()),
): Promise<EnclaveProxyUsage> {
  try {
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory ||
        await fs.realpath(directory) !== directory) return unavailableEnclaveProxyUsage('unsafe');
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== uid || stat.gid !== gid ||
        (stat.mode & 0o7777) !== 0o700) return unavailableEnclaveProxyUsage('unsafe');
    const read = async (name: string, tokens: boolean): Promise<Source> => {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(path.join(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const file = await handle.stat();
        // token-persistence currently creates token-usage at 0644 inside the
        // private 0700 directory; the lifecycle audit is strictly 0600.
        const mode = file.mode & 0o7777;
        if (!file.isFile() || file.nlink !== 1 || file.uid !== uid || file.gid !== gid ||
            file.dev !== stat.dev || (mode !== 0o600 && !(tokens && mode === 0o644))) {
          return { status: 'unsafe' };
        }
        if (file.size > ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES) return { status: 'oversized' };
        const bytes = Buffer.alloc(ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES + 1);
        let total = 0;
        while (total < bytes.length) {
          const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > ENCLAVE_PROXY_USAGE_MAX_FILE_BYTES) return { status: 'oversized' };
        return project(bytes.subarray(0, total), tokens);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return { status: code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe' : 'read-failed' };
      } finally {
        await handle?.close();
      }
    };
    return {
      scope: 'run-cumulative',
      requests: await read('token-tracker-audit.jsonl', false),
      tokens: await read('token-usage.jsonl', true),
    };
  } catch (error) {
    return unavailableEnclaveProxyUsage((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-failed');
  }
}
