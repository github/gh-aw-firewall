import * as fs from 'fs';
import * as path from 'path';
import { CloudHypervisorManager } from './manager';
import { CloudHypervisorGuestChannel } from './guest-execution';
import { createScriptEnclaveCloudHypervisorProfile } from './workload-profile';
import { HostPreflightReporter } from './host-preflight-progress';
import {
  HostExecutorInvocationDiagnostics, readHostExecutorInvocationDiagnostics,
} from '../enclave/host-executor-journal';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import { config, dependencies, networkConfig, enclaveExportPlan } from './manager.test-utils';

describe('protected shared VMM launch evidence', () => {
  let root: string;
  let run: HostExecutorRunState;
  let diagnostic: HostExecutorInvocationDiagnostics;
  let report: HostPreflightReporter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.vm-launch-evidence-'));
    run = {
      runId: 'a'.repeat(32), journalDir: path.join(root, 'journal'),
      invocationsDir: path.join(root, 'invocations'), seedsDir: path.join(root, 'seeds'), entries: [],
    };
    diagnostic = new HostExecutorInvocationDiagnostics(run, {
      runId: run.runId, invocationId: 'b'.repeat(32), entryId: 'script', executorKind: 'script',
    } as HostExecutorInvocationPlan);
    report = new HostPreflightReporter('host-invocation', diagnostic.publish);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const failure = () => Object.assign(new Error('PRIVATE_TOKEN /private/repo PRIVATE_SCRIPT'), {
    code: 'EACCES', stderr: 'PRIVATE_STDERR',
  });

  it.each(['vmm-launch', 'api-socket', 'api-ping', 'confinement', 'vm-create', 'vm-boot'] as const)(
    'retains %s as the original failure before secondary cleanup/reconcile failures',
    async (stage) => {
      const original = failure();
      const deps = dependencies();
      const client = deps.createClient('/unused', 1);
      if (stage === 'vmm-launch') (deps.launch as jest.Mock).mockImplementation(() => { throw original; });
      if (stage === 'api-socket') (deps.access as jest.Mock).mockRejectedValue(original);
      if (stage === 'api-ping') (client.ping as jest.Mock).mockRejectedValue(original);
      if (stage === 'confinement') (deps.verifyConfinement as jest.Mock).mockRejectedValue(original);
      if (stage === 'vm-create') (client.vmCreate as jest.Mock).mockRejectedValue(original);
      if (stage === 'vm-boot') (client.vmBoot as jest.Mock).mockRejectedValue(original);
      const manager = new CloudHypervisorManager(
        config(), '/tmp/awf', deps, 'evidence', networkConfig(), undefined, undefined, false,
        report.fork('vm-launch'),
      );
      if (stage === 'vm-boot') {
        await diagnostic.check(report, 'manager-start', () => manager.start());
        await expect(diagnostic.check(report, 'instance-start', () => manager.startInstance())).rejects.toBe(original);
        await manager.stop();
      } else {
        await expect(diagnostic.check(report, 'manager-start', () => manager.start())).rejects.toBe(original);
      }
      const before = JSON.parse(readHostExecutorInvocationDiagnostics(run)[0].contents);
      expect(before).toMatchObject({
        failure: { stage: `vm-launch/${stage}`, reason: 'EACCES', code: 'EACCES' },
        checks: { [`vm-launch/${stage}`]: ['failed', 'EACCES'] },
      });
      if (stage !== 'vm-boot') {
        expect(before.checks['vm-launch/vm-boot']).toEqual(['not-attempted', 'none']);
        expect(before.checks['host-invocation/instance-start']).toEqual(['not-attempted', 'none']);
      }
      const cleanup = report.fork('host-invocation-cleanup');
      await expect(diagnostic.check(cleanup, 'manager-stop', () => {
        throw Object.assign(new Error('PRIVATE_CLEANUP'), { code: 'EIO' });
      })).rejects.toThrow('PRIVATE_CLEANUP');
      diagnostic.fail(report, 'manager-start', new Error('Host executor lifecycle is unresolved'));
      const [file] = readHostExecutorInvocationDiagnostics(run);
      const after = JSON.parse(file.contents);
      expect(after.failure).toEqual(before.failure);
      expect(after.cleanupFailure).toMatchObject({ stage: 'host-invocation-cleanup/manager-stop', code: 'EIO' });
      expect(after.failure.sequence).toBeLessThan(after.cleanupFailure.sequence);
      expect(file.contents).not.toMatch(/PRIVATE_|\/private\/repo|stderr/);
      expect(Buffer.byteLength(file.contents)).toBeLessThan(64 * 1024);
      expect(fs.statSync(path.join(run.journalDir!, 'diagnostics', file.name)).mode & 0o777).toBe(0o600);
    },
  );

  it('distinguishes an unentered manager from a completed create and boot', async () => {
    const deps = dependencies();
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'evidence', networkConfig(), undefined, undefined, false,
      report.fork('vm-launch'),
    );
    const read = () => JSON.parse(readHostExecutorInvocationDiagnostics(run)[0].contents);
    expect(read().checks['vm-launch/vmm-launch']).toEqual(['not-attempted', 'none']);
    await diagnostic.check(report, 'manager-start', () => manager.start());
    expect(read().checks['vm-launch/vm-create']).toEqual(['passed', 'none']);
    expect(read().checks['vm-launch/vm-boot']).toEqual(['not-attempted', 'none']);
    await diagnostic.check(report, 'instance-start', () => manager.startInstance());
    expect(read().checks['vm-launch/vm-boot']).toEqual(['passed', 'none']);
    expect(read()).not.toHaveProperty('failure');
    await manager.stop();
  });

  it('distinguishes script enclave no-network setup and boot from guest supervisor connection', async () => {
    const deps = dependencies();
    const original = failure();
    jest.spyOn(CloudHypervisorGuestChannel, 'connect').mockRejectedValue(original);
    const profile = createScriptEnclaveCloudHypervisorProfile({
      enclaveId: 'script-entry', invocationId: 'b'.repeat(32),
      guest: { supervisorBinaryPath: '/opt/awf-supervisor', supervisorSha256: 'a'.repeat(64) },
      exportPlan: enclaveExportPlan('script'),
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'evidence', profile, undefined, undefined, true,
      report.fork('vm-launch'),
    );
    await diagnostic.check(report, 'manager-start', () => manager.start());
    await expect(diagnostic.check(report, 'instance-start', () => manager.startInstance())).rejects.toBe(original);
    expect(deps.createEmptyNetworkNamespace).toHaveBeenCalledTimes(1);
    expect(deps.reserveNetwork).not.toHaveBeenCalled();
    expect(JSON.parse(readHostExecutorInvocationDiagnostics(run)[0].contents)).toMatchObject({
      failure: { stage: 'vm-launch/guest-connect', reason: 'EACCES' },
      checks: {
        'vm-launch/network': ['passed', 'none'],
        'vm-launch/rootfs': ['passed', 'none'],
        'vm-launch/virtiofsd': ['passed', 'none'],
        'vm-launch/vm-create': ['passed', 'none'],
        'vm-launch/vm-boot': ['passed', 'none'],
        'host-invocation/guest-execute': ['not-attempted', 'none'],
      },
    });
    await manager.stop();
  });

  it('persists the create failure before the manager attempts its own failing partial-start cleanup', async () => {
    const deps = dependencies();
    const original = failure();
    (deps.createClient('/unused', 1).vmCreate as jest.Mock).mockRejectedValue(original);
    (deps.rm as jest.Mock).mockImplementation(async () => {
      expect(JSON.parse(readHostExecutorInvocationDiagnostics(run)[0].contents)).toMatchObject({
        failure: { stage: 'vm-launch/vm-create', reason: 'EACCES' },
      });
      throw Object.assign(new Error('PRIVATE_CLEANUP'), { code: 'EIO' });
    });
    const manager = new CloudHypervisorManager(
      config(), '/tmp/awf', deps, 'evidence', networkConfig(), undefined, undefined, false,
      report.fork('vm-launch'),
    );
    await expect(diagnostic.check(report, 'manager-start', () => manager.start()))
      .rejects.toThrow('partial-start cleanup also failed');
    const [file] = readHostExecutorInvocationDiagnostics(run);
    const snapshot = JSON.parse(file.contents);
    expect(snapshot).toMatchObject({
      failure: { stage: 'vm-launch/vm-create', reason: 'EACCES', code: 'EACCES' },
      cleanupFailure: { stage: 'host-invocation-cleanup/manager-stop', reason: 'unknown' },
    });
    expect(snapshot.failure.sequence).toBeLessThan(snapshot.cleanupFailure.sequence);
    expect(file.contents).not.toMatch(/PRIVATE_|\/private\/repo/);
  });
});
