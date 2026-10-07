import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testHelpers } from './main-action';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { initializeEnclaveStartupProgress, updateEnclaveStartupProgress } from '../enclave/startup-progress';
import type { WrapperConfig } from '../types';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import schema from '../cloud-hypervisor/host-preflight-schema.json';
import type { HostPreflightScope, HostPreflightCheck } from '../cloud-hypervisor/host-preflight-progress';
import { observeMountTopology, type MountTopologyEvidence } from '../cloud-hypervisor/mount-topology';

describe('startup progress descriptor publication', () => {
  let directory: string;
  let recordPath: string;
  let config: WrapperConfig;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-progress-'));
    recordPath = path.join(directory, 'awf-startup-error.json');
    config = {
      workDir: directory, proxyLogsDir: directory,
      enclaves: normalizeEnclavesConfig([
        { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
      ]),
    } as WrapperConfig;
    initializeEnclaveStartupProgress(config);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('replaces longer progress records without trailing bytes and keeps the private parent', () => {
    updateEnclaveStartupProgress(config, { stage: 'artifact-preflight' });
    testHelpers.writeStartupFailureDiagnostic(config, new Error('x'.repeat(8192)));
    updateEnclaveStartupProgress(config, { stage: 'initialize', readiness: 'attempted', attempts: 1 });
    testHelpers.writeStartupFailureDiagnostic(
      config, new Error('Enclave startup in progress'), 'enclave-startup-progress',
    );
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    expect(record).toMatchObject({
      phase: 'enclave-startup-progress', message: 'Enclave startup in progress',
      enclaveStartup: { stage: 'initialize', readiness: 'attempted', attempts: 1 },
    });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(recordPath).uid).toBe(process.getuid?.());
    expect(fs.statSync(recordPath).mode & 0o777).toBe(0o644);
  });

  it.each(['symlink', 'hardlink'])('refuses a %s record without modifying its target', (kind) => {
    const target = path.join(directory, 'private-target');
    fs.writeFileSync(target, 'PRIVATE_SENTINEL', { mode: 0o600 });
    if (kind === 'symlink') fs.symlinkSync(target, recordPath);
    else fs.linkSync(target, recordPath);
    testHelpers.writeStartupFailureDiagnostic(config, new Error('startup failed'));
    expect(fs.readFileSync(target, 'utf8')).toBe('PRIVATE_SENTINEL');
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('bounds JSON-escaped fatal messages as well as their unescaped byte length', () => {
    testHelpers.writeStartupFailureDiagnostic(config, new Error('\u0000'.repeat(4096)));
    const bytes = fs.readFileSync(recordPath);
    expect(bytes.length).toBeLessThan(16 * 1024);
    expect(JSON.parse(bytes.toString('utf8')).message)
      .toBe('Enclave startup failure exceeded diagnostic message bound');
  });

  it('keeps the full fine-grained plan plus an escaped fatal error within the reader descriptor bound', async () => {
    const reporter = new HostPreflightReporter('bounded-runtime', (hostPreflight) =>
      updateEnclaveStartupProgress(config, { stage: 'host-preflight', hostPreflight }));
    await expect(reporter.check('tool-mount', () => {
      throw Object.assign(new Error('/private/SECRET'), { code: 'EACCES' });
    })).rejects.toThrow();
    testHelpers.writeStartupFailureDiagnostic(config, new Error('\u0000'.repeat(4096)));
    const bytes = fs.readFileSync(recordPath);
    expect(bytes.length).toBeLessThan(16 * 1024);
    const record = JSON.parse(bytes.toString('utf8'));
    expect(record.message).toBe('Enclave startup failure exceeded diagnostic message bound');
    expect(record.enclaveStartup).toMatchObject({
      stage: 'host-preflight', readiness: 'not-attempted', code: 'none', attempts: 0, httpStatus: null,
      hostPreflight: {
        scope: 'bounded-runtime',
        checks: expect.arrayContaining([{ id: 'tool-mount', result: 'failed', reason: 'EACCES' }]),
      },
    });
    expect(bytes.toString('utf8')).not.toContain('SECRET');
  });

  it('bounds the entire standard checklist, active scope and fatal message to the existing 16 KiB descriptor limit', async () => {
    const longestReason = Object.keys(schema.reasons).sort((left, right) => right.length - left.length)[0];
    for (const scope of Object.keys(schema.scopes) as HostPreflightScope[]) {
      const report = new HostPreflightReporter(scope, (hostPreflight) =>
        updateEnclaveStartupProgress(config, { hostPreflight }));
      for (const check of Object.keys(schema.scopes[scope]) as HostPreflightCheck[]) {
        report.fail(check, Object.assign(new Error('PRIVATE_SENTINEL'), { code: longestReason }));
      }
    }
    // Exercise the largest active scope with all previous scope evidence retained.
    const active = new HostPreflightReporter('bounded-runtime', (hostPreflight) =>
      updateEnclaveStartupProgress(config, { hostPreflight }));
    for (const check of Object.keys(schema.scopes['bounded-runtime']) as HostPreflightCheck[]) {
      active.fail(check, Object.assign(new Error('PRIVATE_SENTINEL'), { code: longestReason }));
    }
    const observation = observeMountTopology(
      '100 1 0:1 / /PRIVATE rw shared:1 master:2 - tmpfs secret rw\n' +
      '101 100 0:1 /artifacts /PRIVATE/artifacts rw shared:1 master:2 - tmpfs secret rw\n',
      '/PRIVATE', '/PRIVATE/artifacts', '/PRIVATE/artifacts/run-secret',
    );
    const mountTopology: MountTopologyEvidence = {
      schemaVersion: 1, bindCalls: 'multiple',
      before: { ...observation, visibleOutsidePeers: 'unknown', snapshotEntries: 'multiple',
        snapshotIds: 'repeated', snapshotParentStack: 'unknown' },
      after: { ...observation, visibleOutsidePeers: 'unknown', snapshotEntries: 'multiple',
        snapshotIds: 'repeated', snapshotParentStack: 'unknown' },
    };
    active.topology(mountTopology);
    testHelpers.writeStartupFailureDiagnostic(config, new Error('x'.repeat(1022)));
    const bytes = fs.readFileSync(recordPath);
    expect(bytes.length).toBeLessThanOrEqual(16 * 1024);
    const record = JSON.parse(bytes.toString('utf8'));
    expect(Object.keys(record.enclaveStartup.startupChecks.checks)).toHaveLength(
      Object.values(schema.scopes).reduce((total, plan) => total + Object.keys(plan).length, 0),
    );
    expect(record.enclaveStartup.startupChecks.ready).toBe(false);
    expect(record.enclaveStartup.hostPreflight).toBeUndefined();
    expect(record.enclaveStartup.mountTopology).toEqual(mountTopology);
    expect(bytes.toString('utf8')).not.toContain('/PRIVATE');
    expect(bytes.toString('utf8')).not.toContain('PRIVATE_SENTINEL');
  });
  it('does not follow a record pathname replaced after descriptor validation', () => {
    fs.writeFileSync(recordPath, 'original', { mode: 0o600 });
    const original = path.join(directory, 'opened-record');
    const target = path.join(directory, 'private-target');
    fs.writeFileSync(target, 'PRIVATE_SENTINEL', { mode: 0o600 });
    const nodeFs = jest.requireActual<typeof fs>('fs');
    const fstat = nodeFs.fstatSync;
    jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const stat = fstat(...args);
      fs.renameSync(recordPath, original);
      fs.symlinkSync(target, recordPath);
      return stat;
    });
    testHelpers.writeStartupFailureDiagnostic(config, new Error('startup failed'));
    expect(fs.readFileSync(target, 'utf8')).toBe('PRIVATE_SENTINEL');
    expect(JSON.parse(fs.readFileSync(original, 'utf8')).enclaveStartup.readiness).toBe('not-attempted');
  });
});
