import { constants, promises as fs } from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sessionDiagnostics = require('../../containers/enclave/agent-executor/session-diagnostics.js') as {
  projectEnclaveSessionDiagnostics(bytes: Buffer): EnclaveSessionDiagnostics;
  OPERATIONS: readonly string[];
};

export const ENCLAVE_SESSION_OPERATIONS = sessionDiagnostics.OPERATIONS;

const MAX_SESSION_BYTES = 1024 * 1024;
type SafeEvent = Record<string, string | number | boolean | null>;

export interface EnclaveSessionDiagnostics {
  status: 'captured' | 'empty' | 'missing' | 'unsafe' | 'oversized' | 'read-failed' | 'invalid' | 'not-stopped';
  bytes?: number;
  rejected?: number;
  dropped?: number;
  events?: SafeEvent[];
  lastEvent?: SafeEvent;
  claudeStreamSummary?: SafeEvent;
  claudeStartupFailure?: SafeEvent;
  failure?: SafeEvent;
  operationErrors?: SafeEvent[];
  storageProbe?: {
    status: 'captured' | 'missing' | 'unsafe' | 'oversized' | 'invalid' | 'read-failed';
    milestones: SafeEvent[];
  };
  normalization?: {
    inputState: 'empty' | 'within-limit' | 'oversized';
    stdoutState: 'empty' | 'present';
  };
  outputVerification?: SafeEvent[];
  output?: {
    stage: 'before-engine' | 'after-engine';
    uid: number | 'other';
    gid: number | 'other';
    paths: SafeEvent[];
  };
  resources?: {
    stage: 'before-engine' | 'after-engine';
    memory: Record<string, number>;
    filesystems: SafeEvent[];
  };
}

/** Project untrusted guest JSON onto closed vocabularies; never retain text, stream hashes or payload sizes. */
export function projectEnclaveSessionDiagnostics(bytes: Buffer): EnclaveSessionDiagnostics {
  return sessionDiagnostics.projectEnclaveSessionDiagnostics(bytes);
}

/** Called only after confirmed VM stop, before the invocation-private mount is removed. */
async function readSession(
  invocationDirectory: string,
  uid: number,
  gid: number,
): Promise<EnclaveSessionDiagnostics | Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const runtime = path.join(invocationDirectory, 'session-state');
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

/** Retention sinks receive only the closed metadata projection, never guest session text. */
export async function readEnclaveSessionDiagnostics(
  invocationDirectory: string,
  uid = 0,
  gid = 0,
  retainPublicSession?: (metadata: string) => Promise<void>,
): Promise<EnclaveSessionDiagnostics> {
  const session = await readSession(invocationDirectory, uid, gid);
  if (!Buffer.isBuffer(session)) return session;
  const metadata = projectEnclaveSessionDiagnostics(session);
  if (retainPublicSession) await retainPublicSession(JSON.stringify(metadata));
  return metadata;
}
