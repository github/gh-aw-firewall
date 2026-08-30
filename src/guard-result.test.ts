import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  GUARD_RESULT_FD_ENV_VAR,
  GUARD_RESULT_SCHEMA_VERSION,
  GuardSnapshot,
  classifyGuardResult,
  resolveGuardResultFd,
  serializeGuardResult,
  validateGuardResultFd,
  writeGuardResult,
} from './guard-result';

function makeSnapshot(overrides: Partial<GuardSnapshot> = {}): GuardSnapshot {
  return {
    proxy_id: 'proxy-1',
    generated_at: 1000,
    local_ai_credits_limit_rejections: 1,
    upstream_403_count: 0,
    final_event: 'local_ai_credits_limit',
    final_event_at: 999,
    ai_credits_total: 10,
    ai_credits_max: 10,
    ...overrides,
  };
}

describe('resolveGuardResultFd', () => {
  it('returns undefined when the env var is unset', () => {
    expect(resolveGuardResultFd({})).toBeUndefined();
  });

  it('returns undefined when the env var is empty', () => {
    expect(resolveGuardResultFd({ [GUARD_RESULT_FD_ENV_VAR]: '' })).toBeUndefined();
  });

  it('parses a valid non-negative integer', () => {
    expect(resolveGuardResultFd({ [GUARD_RESULT_FD_ENV_VAR]: '3' })).toBe(3);
    expect(resolveGuardResultFd({ [GUARD_RESULT_FD_ENV_VAR]: '0' })).toBe(0);
  });

  it('throws on a negative value', () => {
    expect(() => resolveGuardResultFd({ [GUARD_RESULT_FD_ENV_VAR]: '-1' })).toThrow();
  });

  it('throws on a non-numeric value', () => {
    expect(() => resolveGuardResultFd({ [GUARD_RESULT_FD_ENV_VAR]: 'abc' })).toThrow();
  });

  it('throws on a fractional value', () => {
    expect(() => resolveGuardResultFd({ [GUARD_RESULT_FD_ENV_VAR]: '3.5' })).toThrow();
  });
});

describe('validateGuardResultFd', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-guard-result-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a real FIFO opened for writing', () => {
    const fifoPath = path.join(tmpDir, 'result.pipe');
    execSync(`mkfifo ${fifoPath}`);
    // Open both ends so the write-only open below doesn't block.
    const readFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writeFd = fs.openSync(fifoPath, 'w');
    try {
      expect(() => validateGuardResultFd(writeFd)).not.toThrow();
    } finally {
      fs.closeSync(writeFd);
      fs.closeSync(readFd);
    }
  });

  it('rejects a regular file', () => {
    const filePath = path.join(tmpDir, 'not-a-pipe.txt');
    const fd = fs.openSync(filePath, 'w');
    try {
      expect(() => validateGuardResultFd(fd)).toThrow(/anonymous pipe/);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('rejects a symlink target masquerading as the pipe path', () => {
    const realFile = path.join(tmpDir, 'real.txt');
    fs.writeFileSync(realFile, 'data');
    const symlinkPath = path.join(tmpDir, 'link.txt');
    fs.symlinkSync(realFile, symlinkPath);
    const fd = fs.openSync(symlinkPath, 'w');
    try {
      expect(() => validateGuardResultFd(fd)).toThrow(/anonymous pipe/);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('rejects a closed / invalid file descriptor', () => {
    expect(() => validateGuardResultFd(999999)).toThrow(/does not refer to an open file descriptor/);
  });
});

describe('classifyGuardResult', () => {
  const baseInput = {
    awfInvocationId: 'inv-1',
    agentExitCode: 1,
    cleanupSucceeded: true,
    containersRemoved: true,
    apiProxyEnabled: true,
    interrupted: false,
  };

  it('confirms a budget stop when all evidence agrees', () => {
    const snapshot = makeSnapshot();
    const result = classifyGuardResult({
      ...baseInput,
      snapshots: [snapshot, snapshot] as const,
    });
    expect(result.classification).toBe('confirmed_budget_stop');
    expect(result.schema_version).toBe(GUARD_RESULT_SCHEMA_VERSION);
    expect(result.proxy_id).toBe('proxy-1');
    expect(result.final_event).toBe('local_ai_credits_limit');
  });

  it('remains unconfirmed when the API proxy was not enabled', () => {
    const result = classifyGuardResult({ ...baseInput, apiProxyEnabled: false, snapshots: null });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('api_proxy_not_enabled');
  });

  it('remains unconfirmed when the run was interrupted by a signal', () => {
    const snapshot = makeSnapshot();
    const result = classifyGuardResult({
      ...baseInput,
      interrupted: true,
      snapshots: [snapshot, snapshot] as const,
    });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('interrupted_by_signal');
  });

  it('remains unconfirmed when no snapshot could be captured', () => {
    const result = classifyGuardResult({ ...baseInput, snapshots: null });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('no_proxy_snapshot_available');
  });

  it('remains unconfirmed when the two snapshots have different proxy ids', () => {
    const a = makeSnapshot({ proxy_id: 'proxy-1' });
    const b = makeSnapshot({ proxy_id: 'proxy-2' });
    const result = classifyGuardResult({ ...baseInput, snapshots: [a, b] as const });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('proxy_id_mismatch');
  });

  it('remains unconfirmed when the proxy was still active between snapshots', () => {
    const a = makeSnapshot({ local_ai_credits_limit_rejections: 1 });
    const b = makeSnapshot({ local_ai_credits_limit_rejections: 2 });
    const result = classifyGuardResult({ ...baseInput, snapshots: [a, b] as const });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('snapshots_not_quiescent');
  });

  it('remains unconfirmed when cleanup failed', () => {
    const snapshot = makeSnapshot();
    const result = classifyGuardResult({
      ...baseInput,
      cleanupSucceeded: false,
      snapshots: [snapshot, snapshot] as const,
    });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('cleanup_failed');
  });

  it('remains unconfirmed when containers were not confirmed removed', () => {
    const snapshot = makeSnapshot();
    const result = classifyGuardResult({
      ...baseInput,
      containersRemoved: false,
      snapshots: [snapshot, snapshot] as const,
    });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('containers_not_removed');
  });

  it('remains unconfirmed when the agent exited with code 0', () => {
    const snapshot = makeSnapshot();
    const result = classifyGuardResult({
      ...baseInput,
      agentExitCode: 0,
      snapshots: [snapshot, snapshot] as const,
    });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('agent_exit_code_not_nonzero');
  });

  it('remains unconfirmed when the agent exit code is unknown', () => {
    const snapshot = makeSnapshot();
    const result = classifyGuardResult({
      ...baseInput,
      agentExitCode: null,
      snapshots: [snapshot, snapshot] as const,
    });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('agent_exit_code_not_nonzero');
  });

  it('remains unconfirmed when the final event is an upstream 403, not a local limit', () => {
    const snapshot = makeSnapshot({ final_event: 'upstream_403' });
    const result = classifyGuardResult({ ...baseInput, snapshots: [snapshot, snapshot] as const });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('final_event_not_local_limit');
  });

  it('remains unconfirmed when the total is below the configured limit', () => {
    const snapshot = makeSnapshot({ ai_credits_total: 5, ai_credits_max: 10 });
    const result = classifyGuardResult({ ...baseInput, snapshots: [snapshot, snapshot] as const });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('ai_credits_below_configured_limit');
  });

  it('remains unconfirmed when no limit is configured on the proxy', () => {
    const snapshot = makeSnapshot({ ai_credits_max: null });
    const result = classifyGuardResult({ ...baseInput, snapshots: [snapshot, snapshot] as const });
    expect(result.classification).toBe('unconfirmed');
    expect(result.reason).toBe('ai_credits_below_configured_limit');
  });
});

describe('serializeGuardResult / writeGuardResult', () => {
  it('serializes to a single newline-terminated JSON line', () => {
    const result = classifyGuardResult({
      awfInvocationId: 'inv-1',
      agentExitCode: 1,
      cleanupSucceeded: true,
      containersRemoved: true,
      apiProxyEnabled: false,
      interrupted: false,
      snapshots: null,
    });
    const serialized = serializeGuardResult(result);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(JSON.parse(serialized.trim())).toEqual(result);
  });

  it('writes the full payload to a pipe and closes the descriptor', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-guard-result-write-'));
    const fifoPath = path.join(tmpDir, 'result.pipe');
    execSync(`mkfifo ${fifoPath}`);
    const readFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writeFd = fs.openSync(fifoPath, 'w');

    const result = classifyGuardResult({
      awfInvocationId: 'inv-1',
      agentExitCode: 1,
      cleanupSucceeded: true,
      containersRemoved: true,
      apiProxyEnabled: false,
      interrupted: false,
      snapshots: null,
    });

    writeGuardResult(writeFd, result);

    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(readFd, buf, 0, buf.length, null);
    const written = buf.subarray(0, bytesRead).toString('utf8');
    expect(JSON.parse(written.trim())).toEqual(result);

    // The fd was closed by writeGuardResult; closing it again should throw.
    expect(() => fs.closeSync(writeFd)).toThrow();

    fs.closeSync(readFd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when writing to an already-closed descriptor', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-guard-result-closed-'));
    const fifoPath = path.join(tmpDir, 'result.pipe');
    execSync(`mkfifo ${fifoPath}`);
    const readFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writeFd = fs.openSync(fifoPath, 'w');
    fs.closeSync(writeFd);
    fs.closeSync(readFd);

    const result = classifyGuardResult({
      awfInvocationId: 'inv-1',
      agentExitCode: 1,
      cleanupSucceeded: true,
      containersRemoved: true,
      apiProxyEnabled: false,
      interrupted: false,
      snapshots: null,
    });

    expect(() => writeGuardResult(writeFd, result)).not.toThrow();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
