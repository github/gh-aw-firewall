import schema from './host-preflight-schema.json';
import {
  HostPreflightReporter, hostPreflightReason, markHostPreflightError,
  type HostPreflightCheck, type HostPreflightScope,
} from './host-preflight-progress';

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

  it.each([
    new Error('code=ENOENT secret'), 'ENOENT', null,
    { code: 'secret\nENOENT' }, { code: 'code=ENOENT' }, { code: 'unrecognized' },
    { code: '/private/path' }, { code: 'none' }, { code: 13 },
  ])('never classifies arbitrary text or unsupported error fields: %p', (error) => {
    expect(hostPreflightReason(error)).toBe('unknown');
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
});
