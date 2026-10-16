import { testHelpers } from './main-action';
import { MAIN_ACTION_STUB_CONFIG } from './main-action.test-utils';
import { stopCloudHypervisorEnclaveLifecycle } from '../enclave/cloud-hypervisor-lifecycle';
import { cleanup as cleanupWorkDirectory, preserveIptablesAudit, stopContainers } from '../docker-manager';
import { publishEarlyResolvedConfig, publishFinalResolvedConfig, exportResolvedConfigPath } from '../resolved-config-artifact';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { verifyPublicEnclaveDebugRepositories } from '../enclave/public-debug';
import type { WrapperConfig } from '../types';

jest.mock('../resolved-config-artifact');
jest.mock('../enclave/cloud-hypervisor-lifecycle');
jest.mock('../docker-manager');
jest.mock('../enclave/manager', () => ({ teardownEnclaves: jest.fn() }));
jest.mock('../enclave/gateway', () => ({ shutdownEnclaveGateway: jest.fn() }));
jest.mock('../enclave/github-gateway', () => ({ disconnectEnclaveGithubGateway: jest.fn() }));
jest.mock('../enclave/dynamic-delegation', () => ({ stopEnclaveDynamicDelegation: jest.fn() }));

describe('resolved configuration startup artifact handoff', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(process, 'geteuid').mockReturnValue(0);
    jest.mocked(publishEarlyResolvedConfig).mockReturnValue('/run/awf-config-audit/run-test/awf-resolved-config.json');
  });

  afterEach(() => jest.restoreAllMocks());

  it('publishes independently before visibility rejection and uncertain cleanup', async () => {
    const config: WrapperConfig = {
      ...MAIN_ACTION_STUB_CONFIG,
      cloudHypervisor: {
        previewEnabled: true, enclaveDebugPublic: true, mountPolicy: 'workspace-only',
        cloudHypervisorBinary: '/usr/bin/cloud-hypervisor', vcpuCount: 2, memoryMib: 4096,
        apiTimeoutMs: 5000,
      },
      enclaves: normalizeEnclavesConfig([{
        script: {}, runtime: 'cloud-hypervisor',
        repos: [{ repo: 'octo/fixture', sensitivity: 'public' }],
      }]),
    };
    testHelpers.persistConfigAuditArtifact(config, { state: 'preflight' });
    expect(exportResolvedConfigPath).toHaveBeenCalledWith(
      '/run/awf-config-audit/run-test/awf-resolved-config.json',
    );
    const request = jest.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(verifyPublicEnclaveDebugRepositories(config, request)).rejects.toThrow('status=403');
    jest.mocked(stopCloudHypervisorEnclaveLifecycle).mockRejectedValueOnce(new Error('cleanup uncertain'));
    await expect(testHelpers.buildCleanupFn(config, () => false, () => false)()).rejects.toThrow('cleanup uncertain');
    expect(cleanupWorkDirectory).not.toHaveBeenCalled();
    expect(publishFinalResolvedConfig).not.toHaveBeenCalled();
  });

  it('does not hand off the compatibility snapshot until all privileged writers finish', async () => {
    const config = { ...MAIN_ACTION_STUB_CONFIG, auditDir: '/tmp/audit' };
    testHelpers.persistConfigAuditArtifact(config, { state: 'initial-redacted-snapshot' });
    config.agentCommand = 'LATE_RUNTIME_SENTINEL';
    const events: string[] = [];
    jest.mocked(preserveIptablesAudit).mockImplementation(() => { events.push('audit'); return true; });
    jest.mocked(stopContainers).mockImplementation(async () => { events.push('stop'); });
    jest.mocked(cleanupWorkDirectory).mockImplementation(async () => { events.push('cleanup'); });
    jest.mocked(publishFinalResolvedConfig).mockImplementation(() => { events.push('final'); });
    await testHelpers.buildCleanupFn(
      config, () => true, () => false,
    )();
    expect(events).toEqual(['audit', 'stop', 'cleanup', 'final']);
    expect(publishFinalResolvedConfig).toHaveBeenCalledWith(
      '/tmp/audit', '{\n  "state": "initial-redacted-snapshot"\n}\n',
    );
  });

  it('keeps rootless resolved config in the standard audit tree without exporting an early path', async () => {
    jest.mocked(process.geteuid!).mockReturnValue(1001);
    const config = { ...MAIN_ACTION_STUB_CONFIG, auditDir: '/tmp/audit' };
    const snapshot = { state: 'preflight' };

    testHelpers.persistConfigAuditArtifact(config, snapshot);

    expect(publishEarlyResolvedConfig).not.toHaveBeenCalled();
    expect(exportResolvedConfigPath).not.toHaveBeenCalled();
    await testHelpers.buildCleanupFn(config, () => false, () => false)();
    expect(publishFinalResolvedConfig).toHaveBeenCalledWith(
      '/tmp/audit', '{\n  "state": "preflight"\n}\n',
    );
  });

  it('does not publish a compatibility snapshot with keep-containers', async () => {
    await testHelpers.buildCleanupFn(
      { ...MAIN_ACTION_STUB_CONFIG, keepContainers: true }, () => false, () => false,
    )();
    expect(publishFinalResolvedConfig).not.toHaveBeenCalled();
  });

  it('recovers the final broker audit after failed host shutdown without destroying recovery state', async () => {
    jest.mocked(stopCloudHypervisorEnclaveLifecycle).mockRejectedValueOnce(new Error('cleanup uncertain'));
    await expect(testHelpers.buildCleanupFn(
      MAIN_ACTION_STUB_CONFIG, () => true, () => false,
    )()).rejects.toThrow('cleanup uncertain');
    expect(preserveIptablesAudit).toHaveBeenCalledTimes(1);
    expect(stopContainers).not.toHaveBeenCalled();
    expect(cleanupWorkDirectory).not.toHaveBeenCalled();
  });

  it('does not publish a compatibility snapshot when generic cleanup fails', async () => {
    jest.mocked(cleanupWorkDirectory).mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(testHelpers.buildCleanupFn(
      MAIN_ACTION_STUB_CONFIG, () => false, () => false,
    )()).rejects.toThrow('cleanup failed');
    expect(publishFinalResolvedConfig).not.toHaveBeenCalled();
  });

  it('retains the host shutdown failure if final audit recovery also throws', async () => {
    jest.mocked(stopCloudHypervisorEnclaveLifecycle).mockRejectedValueOnce(new Error('cleanup uncertain'));
    jest.mocked(preserveIptablesAudit).mockImplementationOnce(() => { throw new Error('recovery failed'); });
    await expect(testHelpers.buildCleanupFn(
      MAIN_ACTION_STUB_CONFIG, () => true, () => false,
    )()).rejects.toThrow('cleanup uncertain');
    expect(stopContainers).not.toHaveBeenCalled();
    expect(cleanupWorkDirectory).not.toHaveBeenCalled();
  });
});
