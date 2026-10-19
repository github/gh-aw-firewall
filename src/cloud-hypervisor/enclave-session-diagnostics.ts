import { constants, promises as fs } from 'fs';
import * as path from 'path';

const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_EVENTS = 32;
const PATHS = [
  'copilot-executable', 'seed-directory', 'task-input', 'schema-input', 'output-file',
  'session-log', 'agent-directory', 'copilot-log-directory', 'github-agent-id', 'github-bearer',
  'temporary-directory', 'shared-memory',
];
const STAGES = [
  'configuration-accepted', 'input-accepted', 'runtime-paths-ready', 'preflight-completed',
  'engine-launch-attempt', 'engine-started', 'engine-completed', 'output-normalization-started',
  'output-normalized', 'output-write-attempt', 'output-written',
];
const CATEGORIES = [
  'configuration-invalid', 'input-invalid', 'engine-failed', 'result-write-failed', 'deadline-exceeded',
  'not-found', 'permission-denied', 'not-executable', 'not-directory', 'is-directory',
  'read-only-filesystem', 'os-error', 'startup-crash',
];
type SafeEvent = Record<string, string | number | boolean | null>;

export interface EnclaveSessionDiagnostics {
  status: 'captured' | 'empty' | 'missing' | 'unsafe' | 'oversized' | 'read-failed' | 'invalid' | 'not-stopped';
  bytes?: number;
  rejected?: number;
  dropped?: number;
  events?: SafeEvent[];
  lastEvent?: SafeEvent;
  failure?: SafeEvent;
  resources?: {
    stage: 'before-engine' | 'after-engine';
    memory: Record<string, number>;
    filesystems: SafeEvent[];
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function allowed(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function projectEvent(value: Record<string, unknown>): SafeEvent | undefined {
  const result: SafeEvent = {};
  if (value.event === 'progress' && allowed(value.stage, STAGES)) {
    result.event = 'progress';
    result.stage = value.stage;
    for (const key of ['attempt', 'runtimeMs']) if (integer(value[key])) result[key] = value[key];
    if (typeof value.valid === 'boolean') result.valid = value.valid;
  } else if (value.event === 'preflight' && allowed(value.path, PATHS)) {
    result.event = 'preflight';
    result.path = value.path;
    if (allowed(value.type, ['file', 'directory', 'missing', 'other', 'forbidden-seed-mount'])) result.type = value.type;
    for (const key of ['exists', 'executable', 'writable']) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    }
  } else if (value.event === 'failure' && allowed(value.category, CATEGORIES)) {
    result.event = 'failure';
    result.category = value.category;
  } else if (value.event === 'operation-error') {
    const operations = [
      'engine-launch', 'output-reset', 'output-read', 'output-write',
      ...PATHS.map((id) => `preflight-${id}`),
      ...['home-directory', 'copilot-directory', 'copilot-log-directory'].map((id) => `runtime-path-creation-${id}`),
    ];
    if (!allowed(value.operation, operations) || !allowed(value.category, CATEGORIES)) return undefined;
    result.event = 'operation-error';
    result.operation = value.operation;
    result.category = value.category;
    if (integer(value.errno) && value.errno <= 4095) result.errno = value.errno;
  } else if (value.event === 'engine-result' || value.event === 'engine-retry') {
    result.event = value.event;
    if (integer(value.signal) && value.signal <= 64) result.signal = value.signal;
  } else if (value.event === 'success') {
    result.event = 'success';
  } else {
    return undefined;
  }
  if (value.exitCode === null || (Number.isInteger(value.exitCode)
      && typeof value.exitCode === 'number' && value.exitCode >= -64 && value.exitCode <= 255)) {
    result.exitCode = value.exitCode;
  }
  return result;
}

/** Project untrusted guest JSON onto closed vocabularies; never retain text, stream hashes or payload sizes. */
function projectSession(bytes: Buffer): EnclaveSessionDiagnostics {
  if (bytes.length === 0) return { status: 'empty', bytes: 0 };
  const result: EnclaveSessionDiagnostics = {
    status: 'captured', bytes: bytes.length, events: [], rejected: 0, dropped: 0,
  };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { status: 'invalid', bytes: bytes.length };
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(line));
    } catch {
      result.rejected! += 1;
      continue;
    }
    if (!value) {
      result.rejected! += 1;
      continue;
    }
    if (value.event === 'resource-snapshot' && allowed(value.stage, ['before-engine', 'after-engine'])) {
      const memory: Record<string, number> = {};
      const source = record(value.memory);
      for (const key of ['currentBytes', 'peakBytes', 'limitBytes']) {
        if (integer(source?.[key])) memory[key] = source[key];
      }
      const events = record(source?.events);
      for (const key of ['high', 'max', 'oom', 'oom_kill']) {
        if (integer(events?.[key])) memory[key] = events[key];
      }
      const filesystems: SafeEvent[] = [];
      if (Array.isArray(value.filesystems)) {
        for (const id of ['agent-directory', 'temporary-directory', 'shared-memory']) {
          const filesystem = value.filesystems.map(record).find((item) => item?.path === id);
          if (filesystem && integer(filesystem.capacityBytes) && integer(filesystem.availableBytes)) {
            filesystems.push({ path: id, capacityBytes: filesystem.capacityBytes, availableBytes: filesystem.availableBytes });
          }
        }
      }
      result.resources = { stage: value.stage === 'before-engine' ? 'before-engine' : 'after-engine', memory, filesystems };
      continue;
    }
    const event = projectEvent(value);
    if (!event) {
      result.rejected! += 1;
      continue;
    }
    result.lastEvent = event;
    if (event.event === 'failure' || event.event === 'operation-error') result.failure ??= event;
    if (result.events!.length < MAX_EVENTS) result.events!.push(event);
    else result.dropped! += 1;
  }
  if (result.events!.length === 0 && !result.resources) result.status = 'invalid';
  return result;
}

/** Called only after confirmed VM stop, before the invocation-private mount is removed. */
async function readSession(
  invocationDirectory: string,
  uid: number,
  gid: number,
): Promise<EnclaveSessionDiagnostics | Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const runtime = path.join(invocationDirectory, 'runtime');
    if (await fs.realpath(runtime) !== runtime) return { status: 'unsafe' };
    const directory = await fs.lstat(runtime);
    if (!directory.isDirectory() || directory.uid !== uid || directory.gid !== gid
        || (directory.mode & 0o7777) !== 0o700) return { status: 'unsafe' };
    handle = await fs.open(path.join(runtime, 'session.jsonl'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid
        || stat.dev !== directory.dev || (stat.mode & 0o7777) !== 0o600) return { status: 'unsafe' };
    if (stat.size > MAX_SESSION_BYTES) return { status: 'oversized' };
    const bytes = Buffer.alloc(MAX_SESSION_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_SESSION_BYTES) return { status: 'oversized' };
    return bytes.subarray(0, total);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe' : 'read-failed' };
  } finally {
    await handle?.close();
  }
}

/** Public text is handed only to a trusted host sink, never included in the audit projection. */
export async function readEnclaveSessionDiagnostics(
  invocationDirectory: string,
  uid = 65534,
  gid = 65534,
  retainPublicSession?: (contents: string) => Promise<void>,
): Promise<EnclaveSessionDiagnostics> {
  const session = await readSession(invocationDirectory, uid, gid);
  if (!Buffer.isBuffer(session)) return session;
  if (retainPublicSession) await retainPublicSession(session.toString('utf8'));
  return projectSession(session);
}
