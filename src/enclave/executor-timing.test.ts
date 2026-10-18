/* eslint-disable @typescript-eslint/no-require-imports */
const { createExecutorHandler } = require('../../containers/enclave/script-executor/executor-handler');
const { createProtectedAuditLog } = require('../../containers/bounded-execution/protected-audit');
const { TIMEOUT_BOUNDARY_GRACE_MS } = require('../../containers/bounded-execution/fixed-timing');
/* eslint-enable @typescript-eslint/no-require-imports */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from './host-executor-protocol';

describe('protected execution versus cleanup and padding evidence', () => {
  function fixture(options: { workMs?: number; cleanupMs?: number; cleanupFails?: boolean; jitter?: number } = {}) {
    let now = 0;
    const events: Array<Record<string, unknown>> = [];
    const runner = {
      hostOwned: false,
      runInvocation: jest.fn(async () => {
        now += options.workMs ?? 65_000;
        return { exitCode: 1, timedOut: false };
      }),
    };
    const audit = { failure: jest.fn(), invocation: jest.fn() };
    const destroyWorkspace = jest.fn(() => {
      now += options.cleanupMs ?? 0;
      if (options.cleanupFails) throw new Error('PRIVATE_CLEANUP_PATH');
    });
    const handler = createExecutorHandler({
      config: { timeoutSeconds: 120, maxInvocations: 2, maxOutputBytes: 8192 },
      seedMap: new Map([['octo/fixture', { seedId: 'seed', sensitivity: 'public' }]]),
      runId: 'run', runner, audit,
      diagnosticAudit: { lifecycle: (_event: string, record: Record<string, unknown>) => { events.push(record); } },
      workspace: {
        createInvocationWorkspace: () => ({}),
        destroyInvocationWorkspace: destroyWorkspace,
      },
      clock: { nowMs: () => now, sleep: async (ms: number) => { now += ms; } },
      responseJitterSource: () => options.jitter ?? 821,
    });
    const request = { privateRepo: 'octo/fixture', schema: { type: 'boolean' }, script: 'PRIVATE_SCRIPT' };
    return { handler, request, events, audit, runner, destroyWorkspace, now: () => now };
  }

  it('persists the actual 65s failure before waiting to return at 120.821s', async () => {
    const f = fixture();
    let response;
    await f.handler.handle(f.request, (json: string) => { response = json; });
    expect(response).toBe('{"status":"error"}');
    expect(f.now()).toBe(120_821);
    expect(f.now()).toBeGreaterThan(120_000);
    expect(f.runner.runInvocation).toHaveBeenCalledTimes(1);
    expect(f.destroyWorkspace).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'work-complete', elapsedMs: 65_000, reason: 'non-zero-exit' }),
      expect.objectContaining({ phase: 'cleanup-complete', elapsedMs: 65_000, status: 'ok' }),
      expect.objectContaining({ phase: 'bucket-selected', bucketMs: 120_000 }),
      expect.objectContaining({ phase: 'padding-start', elapsedMs: 65_000 }),
      expect.objectContaining({ phase: 'padding-wake', elapsedMs: 120_000, lateWakeMs: 0 }),
      expect.objectContaining({ phase: 'padding-complete', elapsedMs: 120_821, jitterMs: 821 }),
      expect.objectContaining({ phase: 'response', elapsedMs: 120_821, status: 'error' }),
    ]));
    expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE|payload|repo|stack|message/);
  });

  it('keeps the original work failure when cleanup crosses a boundary and also fails', async () => {
    const f = fixture({ workMs: 59_999, cleanupMs: 2, cleanupFails: true, jitter: 1000 });
    await f.handler.handle(f.request, () => undefined);
    expect(f.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'work-complete', elapsedMs: 59_999, reason: 'non-zero-exit' }),
      expect.objectContaining({ phase: 'cleanup-failed', elapsedMs: 60_001 }),
      expect.objectContaining({ phase: 'cleanup-complete', status: 'error' }),
      expect.objectContaining({ phase: 'response', bucketMs: 120_000, reason: 'non-zero-exit' }),
    ]));
    expect(f.now()).toBe(121_000);
    expect(f.audit.failure).toHaveBeenLastCalledWith(expect.any(String), 'non-zero-exit', 'exit=1');
  });

  it('passes one shared 1s grace to the host runner without altering local runner deadlines', async () => {
    expect(TIMEOUT_BOUNDARY_GRACE_MS).toBe(HOST_EXECUTOR_TIMEOUT_GRACE_MS);
    for (const hostOwned of [false, true]) {
      const f = fixture({ workMs: 1 });
      f.runner.hostOwned = hostOwned;
      await f.handler.handle(f.request, () => undefined);
      expect(f.runner.runInvocation).toHaveBeenCalledWith(expect.objectContaining({
        deadlineMs: 120_000 + (hostOwned ? 1000 : 0),
      }));
    }
  });

  it('does not copy protected records or raw storage errors into ordinary stderr on persistence failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-protected-audit-'));
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const log = createProtectedAuditLog(root, 'enclave-host-executor.jsonl');
      const write = jest.spyOn(jest.requireActual<typeof import('fs')>('fs'), 'writeSync').mockImplementation(() => {
        throw new Error('PRIVATE_PATH_SECRET');
      });
      log.lifecycle('invocation-timing', { phase: 'work-complete', elapsedMs: 65_000 });
      write.mockRestore();
      log.lifecycle('invocation-timing', { phase: 'padding-start', elapsedMs: 65_000 });
      expect(stderr).toHaveBeenCalledWith('[awf-enclave] protected audit unavailable (reason=write-failed)\n');
      expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/PRIVATE|65000|work-complete|padding-start/);
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
