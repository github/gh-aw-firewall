import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import schema from '../cloud-hypervisor/host-preflight-schema.json';
import { HostPreflightReporter, type HostPreflightCheck } from '../cloud-hypervisor/host-preflight-progress';
import {
  assertEnclaveStartupChecklistComplete, getEnclaveStartupProgress,
  initializeEnclaveStartupProgress, resetEnclaveStartupChecklist, updateEnclaveStartupProgress,
} from './startup-progress';

function config(): WrapperConfig {
  return { enclaves: normalizeEnclavesConfig([{ script: {}, repos: [] }]) } as WrapperConfig;
}

describe('standard enclave startup checklist', () => {
  it('retains earlier storage evidence when actual connectivity checks begin and blocks readiness on either failure', async () => {
    const wrapper = config();
    const publish = (hostPreflight: Parameters<typeof updateEnclaveStartupProgress>[1]['hostPreflight']) =>
      updateEnclaveStartupProgress(wrapper, { hostPreflight });
    const startup = new HostPreflightReporter('startup', publish);
    const storage = new HostPreflightReporter('storage-admission', publish);
    await storage.check('root', () => undefined);
    const gateway = new HostPreflightReporter('gateway-handshake', publish);
    await gateway.check('contract', () => undefined);
    await expect(gateway.check('initialize', () => {
      throw Object.assign(new Error('/private/SECRET'), { code: 'connection-refused' });
    })).rejects.toThrow();
    const record = getEnclaveStartupProgress(wrapper)!;
    expect(record.startupChecks).toMatchObject({
      ready: false, checks: {
        'storage-admission/root': ['passed', 'none'],
        'storage-admission/kvm-open': ['not-attempted', 'none'],
        'gateway-handshake/initialize': ['failed', 'connection-refused'],
        'gateway-handshake/tools-list': ['not-attempted', 'none'],
        'startup/readiness': ['not-attempted', 'none'],
      },
    });
    expect(() => assertEnclaveStartupChecklistComplete(wrapper)).toThrow(/incomplete required checks/);
    await expect(startup.check('readiness', () => assertEnclaveStartupChecklistComplete(wrapper))).rejects.toThrow();
    expect(getEnclaveStartupProgress(wrapper)!.startupChecks!.ready).toBe(false);
    expect(JSON.stringify(record)).not.toContain('SECRET');
  });

  it('permits only explicitly optional checks to be not required and sets readiness after the complete list', async () => {
    const wrapper = config();
    const startup = new HostPreflightReporter('startup', (hostPreflight) =>
      updateEnclaveStartupProgress(wrapper, { hostPreflight }));
    expect(() => startup.notRequired('gateway-ready')).toThrow(/cannot be skipped/);
    startup.notRequired('github-attachment');
    startup.notRequired('github-ready');
    startup.notRequired('delegation');
    for (const id of Object.keys(schema.scopes.startup) as HostPreflightCheck[]) {
      if (id === 'readiness' || ['github-attachment', 'github-ready', 'delegation'].includes(id)) continue;
      await startup.check(id, () => undefined);
    }
    expect(getEnclaveStartupProgress(wrapper)!.startupChecks!.ready).toBe(false);
    expect(() => assertEnclaveStartupChecklistComplete(wrapper)).toThrow(/incomplete required checks/);
    await startup.check('readiness', () => assertEnclaveStartupChecklistComplete(wrapper, true));
    expect(getEnclaveStartupProgress(wrapper)!.startupChecks!.ready).toBe(true);
    expect(() => assertEnclaveStartupChecklistComplete(wrapper)).not.toThrow();
  });

  it('resets every startup rather than inheriting previous passed checks or readiness', async () => {
    const wrapper = config();
    const events = jest.fn();
    initializeEnclaveStartupProgress(wrapper, events);
    const report = new HostPreflightReporter('startup', (hostPreflight) =>
      updateEnclaveStartupProgress(wrapper, { hostPreflight }));
    await report.check('configuration', () => undefined);
    resetEnclaveStartupChecklist(wrapper);
    expect(getEnclaveStartupProgress(wrapper)).toMatchObject({ readiness: 'not-attempted', attempts: 0, code: 'none' });
    expect(getEnclaveStartupProgress(wrapper)!.startupChecks).toBeUndefined();
    expect(() => assertEnclaveStartupChecklistComplete(wrapper)).toThrow();
    new HostPreflightReporter('startup', (hostPreflight) => updateEnclaveStartupProgress(wrapper, { hostPreflight }));
    expect(getEnclaveStartupProgress(wrapper)!.startupChecks!.checks['startup/configuration'])
      .toEqual(['not-attempted', 'none']);
    expect(events).toHaveBeenCalled();
    events.mock.calls[events.mock.calls.length - 1][0].startupChecks.checks['startup/configuration'][0] = 'passed';
    expect(getEnclaveStartupProgress(wrapper)!.startupChecks!.checks['startup/configuration'][0]).toBe('not-attempted');
  });
});
