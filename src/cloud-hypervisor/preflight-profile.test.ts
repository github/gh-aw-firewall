import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  HostPreflightReporter, type HostPreflightProgress,
} from './host-preflight-progress';
import {
  runCloudHypervisorCommonPreflight,
  runCloudHypervisorPreflight,
} from './preflight';

describe('Cloud Hypervisor default preflight profile', () => {
  const config = { cloudHypervisorBinary: '/opt/cloud-hypervisor' } as CloudHypervisorOptions;
  const deps = { uid: 1000 };

  it.each([
    ['common', runCloudHypervisorCommonPreflight],
    ['primary', runCloudHypervisorPreflight],
  ] as const)('starts default %s preflight with a versioned profile', async (profile, run) => {
    const records: HostPreflightProgress[] = [];
    await expect(run(config, { ...deps, onHostPreflight: value => records.push(value) }))
      .rejects.toThrow('requires guest kernel');
    expect(records[0]).toMatchObject({
      schemaVersion: 2, scope: 'bounded-runtime', phase: 'preflight', profile,
    });
    expect(records[records.length - 1].checks.find((check) => check.id === 'artifact-configuration'))
      .toMatchObject({ result: 'failed' });
  });

  it('honors an explicitly supplied legacy reporter rather than replacing it', async () => {
    const records: HostPreflightProgress[] = [];
    const injected = new HostPreflightReporter('bounded-runtime', (value) => records.push(value));
    await expect(runCloudHypervisorCommonPreflight(config, { ...deps, hostPreflightReporter: injected }))
      .rejects.toThrow('requires guest kernel');
    expect(records[records.length - 1]).toMatchObject({ schemaVersion: 1, scope: 'bounded-runtime' });
    expect(records[records.length - 1]).not.toHaveProperty('profile');
  });
});
