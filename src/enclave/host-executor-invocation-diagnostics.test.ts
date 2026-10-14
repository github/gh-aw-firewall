import * as fs from 'fs';
import * as path from 'path';
import {
  HostExecutorInvocationDiagnostics, readHostExecutorInvocationDiagnostics,
} from './host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import { logger } from '../logger';

describe('protected host invocation evidence', () => {
  let root: string;
  let run: HostExecutorRunState;
  let plan: HostExecutorInvocationPlan;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.host-invocation-evidence-'));
    run = {
      runId: 'a'.repeat(32), journalDir: path.join(root, 'journal'),
      invocationsDir: path.join(root, 'invocations'), seedsDir: path.join(root, 'seeds'), entries: [],
    };
    plan = {
      runId: run.runId, invocationId: 'b'.repeat(32), entryId: 'script', executorKind: 'script',
      payload: 'PRIVATE_SCRIPT', seedHostPath: '/PRIVATE_REPOSITORY',
    } as HostExecutorInvocationPlan;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the specific origin and separate cleanup failure without untrusted error text', async () => {
    const diagnostic = new HostExecutorInvocationDiagnostics(run, plan);
    const report = new HostPreflightReporter('host-invocation', diagnostic.publish);
    const origin = Object.assign(new TypeError('Bearer SECRET /private/repository'), {
      code: 'EACCES', stderr: 'PRIVATE_STDERR', env: { TOKEN: 'PRIVATE_TOKEN' },
    });
    await expect(diagnostic.check(report, 'filesystem', async () => {
      const storage = report.fork('bounded-runtime');
      await storage.check('storage-layout', () => { throw origin; });
    })).rejects.toBe(origin);
    const cleanup = report.fork('host-invocation-cleanup');
    await expect(diagnostic.check(cleanup, 'filesystem-remove', () => {
      throw { name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', message: 'PRIVATE_MESSAGE' };
    })).rejects.toMatchObject({ code: 'PRIVATE_CODE' });
    const [file] = readHostExecutorInvocationDiagnostics(run);
    const snapshot = JSON.parse(file.contents);
    expect(snapshot).toMatchObject({
      failure: { stage: 'bounded-runtime/storage-layout', reason: 'EACCES', code: 'EACCES', errorType: 'TypeError' },
      cleanupFailure: {
        stage: 'host-invocation-cleanup/filesystem-remove', reason: 'unknown', code: 'unknown', errorType: 'unknown',
      },
      checks: {
        'host-invocation/filesystem': ['failed', 'EACCES'],
        'host-invocation/manager-start': ['not-attempted', 'none'],
        'host-invocation-cleanup/storage-close': ['not-attempted', 'none'],
      },
    });
    expect(snapshot.failure.sequence).toBeLessThan(snapshot.cleanupFailure.sequence);
    expect(file.contents).not.toMatch(/PRIVATE_|SECRET|Bearer|\/private\/|TOKEN/);
    expect(Buffer.byteLength(file.contents)).toBeLessThan(64 * 1024);
  });

  it('retains the earlier durable snapshot and reports later persistence failure without blocking cleanup work', async () => {
    const diagnostic = new HostExecutorInvocationDiagnostics(run, plan);
    const report = new HostPreflightReporter('host-invocation', diagnostic.publish);
    const before = readHostExecutorInvocationDiagnostics(run)[0].contents;
    const warning = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(jest.requireActual<typeof import('fs')>('fs'), 'renameSync')
      .mockImplementation(() => { throw new Error('SECRET storage failure'); });
    const operation = jest.fn().mockResolvedValue(undefined);
    await diagnostic.check(report, 'manager-start', operation);
    await diagnostic.check(report.fork('host-invocation-cleanup'), 'manager-stop', operation);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(diagnostic.persistenceFailed).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('SECRET');
    expect(readHostExecutorInvocationDiagnostics(run)[0].contents).toBe(before);
  });

  it('rejects symlinked diagnostic storage before resource creation', () => {
    fs.mkdirSync(run.journalDir!, { mode: 0o700 });
    fs.symlinkSync(root, path.join(run.journalDir!, 'diagnostics'));
    expect(() => new HostExecutorInvocationDiagnostics(run, plan)).toThrow('Unsafe journal ancestor');
  });
});
