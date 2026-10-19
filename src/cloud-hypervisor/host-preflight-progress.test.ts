import {
  HostPreflightReporter, HostPreflightReportingError, hostPreflightReason, markHostPreflightError,
  type HostPreflightCheck, type HostPreflightScope, type HostPreflightProgress,
} from './host-preflight-progress';
import { schema } from './host-preflight-schema';

describe('bounded actual-host preflight progress', () => {
  const scopes = Object.keys(schema.scopes) as HostPreflightScope[];
  it.each(scopes.flatMap((scope) =>
    Object.keys(schema.scopes[scope]).map((id) => ({ scope, id: id as HostPreflightCheck }))))(
    'reports a failing $scope/$id without passing unexecuted gates', async ({ scope, id }) => {
      const publish = jest.fn();
      const reporter = new HostPreflightReporter(scope, publish);
      const error = Object.assign(new Error('/private/SECRET\nBearer credential'), { code: 'EPERM' });
      await expect(reporter.check(id, () => { throw error; })).rejects.toBe(error);
      const value = publish.mock.calls[publish.mock.calls.length - 1][0];
      expect(value).toEqual({
        schemaVersion: 1, scope,
        checks: Object.keys(schema.scopes[scope]).map((check) => ({
          id: check, result: check === id ? 'failed' : 'not-attempted',
          reason: check === id ? 'EPERM' : 'none',
        })),
      });
      expect(JSON.stringify(value)).not.toMatch(/\/private\/|SECRET|Bearer|credential/);
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(8192);
      expect(publish.mock.calls[0][0].checks.every((check: { result: string }) =>
        check.result === 'not-attempted')).toBe(true);
    },
  );

  it('preserves successful values and publishes isolated snapshots before and after actual execution', async () => {
    const publish = jest.fn();
    const reporter = new HostPreflightReporter('storage-admission', publish);
    await expect(reporter.check('root', () => 42)).resolves.toBe(42);
    expect(publish.mock.calls.map(([value]) => value.checks[0].result))
      .toEqual(['not-attempted', 'attempted', 'passed']);
    publish.mock.calls[0][0].checks[0].result = 'failed';
    await reporter.check('runner-eligibility', () => undefined);
    expect(publish.mock.calls[publish.mock.calls.length - 1][0].checks[0].result).toBe('passed');
  });

  it('emits versioned phase/profile evidence and keeps cleanup distinct from its original failure', async () => {
    const records: HostPreflightProgress[] = [];
    const report = new HostPreflightReporter('bounded-artifacts', (value) =>
      records.push(value), undefined, { phase: 'preflight', profile: 'common' });
    const error = markHostPreflightError(new Error('PRIVATE_TOKEN'), 'attestation-failed');
    await expect(report.check('manifest-attestation', async () => { throw error; })).rejects.toBe(error);
    const cleanup = report.fork('bounded-cleanup');
    const cleanupError = Object.assign(new Error('PRIVATE_CLEANUP'), { code: 'EIO' });
    await expect(cleanup.check('storage-close', async () => { throw cleanupError; })).rejects.toBe(cleanupError);
    expect(records[records.length - 1]).toMatchObject({
      schemaVersion: 2, scope: 'bounded-cleanup', phase: 'cleanup', profile: 'common',
    });
    expect(records[records.length - 1].checks[0])
      .toMatchObject({ id: 'storage-close', result: 'failed', reason: 'EIO' });
    expect(records.find((record) => record.scope === 'bounded-artifacts' &&
      record.checks.some((entry: { reason: string }) => entry.reason === 'attestation-failed')))
      .toMatchObject({ schemaVersion: 2, phase: 'preflight', profile: 'common' });
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_TOKEN|PRIVATE_CLEANUP/);
  });

  it.each([
    new Error('code=ENOENT secret'), 'ENOENT', null,
    { code: 'secret\nENOENT' }, { code: 'code=ENOENT' }, { code: 'unrecognized' },
    { code: '/private/path' }, { code: 'none' }, { code: 13 },
  ])('never classifies arbitrary text or unsupported error fields: %p', (error) => {
    expect(hostPreflightReason(error)).toBe('unknown');
  });

  it.each(['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT'])('distinguishes allowlisted permission/storage code %s', (code) => {
    const error = Object.assign(new Error('PRIVATE_PATH_TOKEN'), { code });
    expect(hostPreflightReason(error)).toBe(code);
  });

  it('uses origin classification without modifying an error or replacing its identity', () => {
    const error = Object.freeze(new Error('unchanged private diagnostic'));
    expect(markHostPreflightError(error, 'ancestor-owner')).toBe(error);
    expect(hostPreflightReason(error)).toBe('ancestor-owner');
    expect(Object.keys(error)).toEqual([]);
  });

  it('reports synchronous commit checks without replacing thrown objects or passing later operations', () => {
    const publish = jest.fn();
    const reporter = new HostPreflightReporter('storage-mount-capture', publish);
    expect(reporter.checkSync('journal-open', () => 42)).toBe(42);
    const error = Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'EIO' });
    expect(() => reporter.checkSync('journal-write', () => { throw error; })).toThrow(error);
    const last = publish.mock.calls[publish.mock.calls.length - 1][0];
    expect(last.checks.find((check: { id: string }) => check.id === 'journal-open')).toMatchObject({ result: 'passed' });
    expect(last.checks.find((check: { id: string }) => check.id === 'journal-write')).toMatchObject({
      result: 'failed', reason: 'EIO',
    });
    expect(last.checks.find((check: { id: string }) => check.id === 'journal-publish')).toMatchObject({ result: 'not-attempted' });
    expect(JSON.stringify(publish.mock.calls)).not.toContain('PRIVATE_SENTINEL');
  });

  it.each(['sync', 'async'] as const)(
    'retains the original %s failure when publishing its diagnostic fails', async (kind) => {
      const primary = Object.assign(new Error('PRIVATE_PRIMARY'), { code: 'EACCES' });
      const persistence = new Error('PRIVATE_PERSISTENCE');
      const publish = jest.fn((value: HostPreflightProgress) => {
        if (value.checks[0].result === 'failed') throw persistence;
      });
      const report = new HostPreflightReporter('storage-admission', publish);
      let observed: unknown;
      try {
        if (kind === 'sync') report.checkSync('root', () => { throw primary; });
        else await report.check('root', () => { throw primary; });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(HostPreflightReportingError);
      expect(observed).toMatchObject({ cause: primary, reportingError: persistence });
      expect(hostPreflightReason(observed)).toBe('EACCES');
    },
  );
});
