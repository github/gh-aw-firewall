import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  HostPreflightReporter, type HostPreflightProgress,
} from './host-preflight-progress';
import {
  runCloudHypervisorCommonPreflight,
  runCloudHypervisorPreflight,
} from './preflight';

jest.mock('./host-preflight-progress', () => {
  const actual = jest.requireActual<typeof import('./host-preflight-progress')>('./host-preflight-progress');
  return {
    ...actual,
    HostPreflightReporter: jest.fn((
      scope: string,
      publish: ((value: HostPreflightProgress) => void) | undefined,
      onFailure: unknown,
      context: unknown,
    ) => new actual.HostPreflightReporter(scope as 'bounded-runtime', publish,
      onFailure as undefined, context as undefined)),
  };
});

describe('Cloud Hypervisor default preflight profile', () => {
  const config = { cloudHypervisorBinary: '/opt/cloud-hypervisor' } as CloudHypervisorOptions;
  const deps = { uid: 1000 };

  it.each([
    ['common', runCloudHypervisorCommonPreflight],
    ['primary', runCloudHypervisorPreflight],
  ] as const)('starts default %s preflight with a versioned profile', async (profile, run) => {
    const reporter = HostPreflightReporter as jest.MockedClass<typeof HostPreflightReporter>;
    reporter.mockClear();
    const actual = jest.requireActual<typeof import('./host-preflight-progress')>('./host-preflight-progress');
    const records: HostPreflightProgress[] = [];
    reporter.mockImplementationOnce((scope, publish, onFailure, context) =>
      new actual.HostPreflightReporter(scope, (value) => {
        records.push(value);
        publish?.(value);
      }, onFailure, context));
    await expect(run(config, deps)).rejects.toThrow('requires guest kernel');
    expect(reporter).toHaveBeenCalledWith(
      'bounded-runtime', undefined, undefined, { phase: 'preflight', profile },
    );
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      schemaVersion: 2, scope: 'bounded-runtime', phase: 'preflight', profile,
    });
    expect(records[records.length - 1].checks.find((check) => check.id === 'artifact-configuration'))
      .toMatchObject({ result: 'failed' });
  });

  it('honors an explicitly supplied legacy reporter rather than replacing it', async () => {
    const actual = jest.requireActual<typeof import('./host-preflight-progress')>('./host-preflight-progress');
    const records: HostPreflightProgress[] = [];
    const injected = new actual.HostPreflightReporter('bounded-runtime', (value) => records.push(value));
    const reporter = HostPreflightReporter as jest.MockedClass<typeof HostPreflightReporter>;
    reporter.mockClear();
    await expect(runCloudHypervisorCommonPreflight(config, { ...deps, hostPreflightReporter: injected }))
      .rejects.toThrow('requires guest kernel');
    expect(reporter).not.toHaveBeenCalled();
    expect(records[records.length - 1]).toMatchObject({ schemaVersion: 1, scope: 'bounded-runtime' });
    expect(records[records.length - 1]).not.toHaveProperty('profile');
  });
});
