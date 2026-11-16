import { promises as fs } from 'fs';
import * as path from 'path';
import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } from './artifact-manifest';
import * as artifactTrust from './artifact-trust';
import { HostPreflightReporter, type HostPreflightProgress } from './host-preflight-progress';
import * as cloudHypervisorPreflight from './preflight';
import { createCloudHypervisorHostEnclaveExecutor } from './host-enclave-executor';
import type { HostExecutorRunState } from '../enclave/host-executor-server';
import * as hostExecutorResourceJournal from '../enclave/host-executor-resource-journal';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorCommonPreflightResult, CloudHypervisorHostToolPaths } from './preflight';
import { cloudHypervisorManagerTestHelpers } from './manager';
import { createExecutorScratchDirectory } from './host-enclave-executor.test-utils';

describe('createCloudHypervisorHostEnclaveExecutor', () => {
  it('requires staged and verified enclave artifacts before creating the executor', async () => {
    const onPreflightStage = jest.fn();
    const options = {
      runState: {} as HostExecutorRunState,
      config: { artifactReleaseTag: 'v0.23.1' } as CloudHypervisorOptions,
      workDir: '/tmp/awf-enclave',
      environment: {},
      onPreflightStage,
    };
    await expect(createCloudHypervisorHostEnclaveExecutor(options))
      .rejects.toThrow('Cloud Hypervisor enclave artifacts have not been staged and verified');
    expect(onPreflightStage.mock.calls).toEqual([['artifact-preflight']]);
  });

  it('resolves the trusted CLI and removes preflight artifacts when artifact verification fails', async () => {
    const scratch = await createExecutorScratchDirectory('.awf-enclave-factory-');
    const environment = {
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: '/missing/manifest.json',
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE:
        '/missing/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: '/missing/enclave-script-rootfs.ext4',
      AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: '/missing/enclave-agent-rootfs.ext4',
      PATH: scratch,
    };
    await fs.writeFile(path.join(scratch, 'gh'), '', { mode: 0o700 });
    const options = {
      runState: { journalDir: path.join(scratch, 'journal') } as HostExecutorRunState,
      config: { artifactReleaseTag: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } as CloudHypervisorOptions,
      workDir: scratch,
      managerDependencies: {
        ...cloudHypervisorManagerTestHelpers.defaultDependencies,
        cleanupRegistry: {
          reapPending: async () => undefined,
          hasPendingRecord: async () => false,
          create: async () => { throw new Error('unexpected cleanup creation'); },
          createPending: async () => { throw new Error('unexpected cleanup creation'); },
        },
      },
      environment,
    };
    const preflight = {
      version: '53.0',
      cloudHypervisorBinary: '/trusted/cloud-hypervisor',
      virtiofsdBinary: '/trusted/virtiofsd',
      kernelPath: '/trusted/vmlinux.bin',
      supervisorPath: '/trusted/awf-supervisor',
      artifactSnapshotDirectory: path.join(scratch, 'preflight-snapshot'),
      artifactDigests: {
        cloudHypervisor: 'a'.repeat(64), virtiofsd: 'b'.repeat(64),
        kernel: 'c'.repeat(64), supervisor: 'd'.repeat(64),
      },
      tools: { ip: '/trusted/ip', umount: '/trusted/umount' } as CloudHypervisorHostToolPaths,
      cgroupVersion: 2,
      kvmGid: 978,
    } satisfies CloudHypervisorCommonPreflightResult;
    const runPreflight = jest.spyOn(
      cloudHypervisorPreflight,
      'runCloudHypervisorCommonPreflight',
    ).mockResolvedValue(preflight);
    const trustedTool = jest.spyOn(
      artifactTrust,
      'assertTrustedHostTool',
    ).mockResolvedValue();
    const removeSnapshot = jest.fn(async () => undefined);
    const reap = jest.spyOn(hostExecutorResourceJournal, 'reapHostExecutorResources').mockResolvedValue();
    const published: HostPreflightProgress[] = [];

    try {
      await expect(createCloudHypervisorHostEnclaveExecutor({
        ...options,
        environment: { ...environment, PATH: '' },
      })).rejects.toThrow('A trusted GitHub CLI is required');
      await expect(createCloudHypervisorHostEnclaveExecutor({
        ...options, onHostPreflight: (value) => { published.push(value); },
      }, {
        removeArtifactSnapshot: removeSnapshot,
      })).rejects.toThrow();
      expect(runPreflight).toHaveBeenCalledTimes(1);
      expect(removeSnapshot).toHaveBeenCalledWith(preflight.artifactSnapshotDirectory);
      const artifactFailure = published.find((value) => value.scope === 'bounded-artifacts' &&
        value.checks.some((check) => check.id === 'manifest-trust' && check.result === 'failed'));
      expect(artifactFailure).toMatchObject({
        schemaVersion: 2, phase: 'preflight', profile: 'common',
      });
      expect(artifactFailure?.checks.find((check) => check.id === 'manifest-trust'))
        .toMatchObject({ result: 'failed', reason: 'ENOENT' });
      const boundedArtifactPreflight = jest.fn().mockRejectedValue(new Error('bounded artifact gate'));
      const onPreflightStage = jest.fn();
      await expect(createCloudHypervisorHostEnclaveExecutor({ ...options, onPreflightStage }, {
        preflight: async () => preflight,
        preflightEnclaveArtifacts: boundedArtifactPreflight,
        removeArtifactSnapshot: removeSnapshot,
      })).rejects.toThrow('bounded artifact gate');
      expect(onPreflightStage.mock.calls).toEqual([
        ['artifact-preflight'], ['host-preflight'], ['recovery'], ['artifact-preflight'],
      ]);
      expect(boundedArtifactPreflight).toHaveBeenCalledWith(expect.objectContaining({
        manifestPath: environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST,
      }), undefined, undefined, expect.any(HostPreflightReporter));
      onPreflightStage.mockClear();
      await expect(createCloudHypervisorHostEnclaveExecutor({ ...options, onPreflightStage }, {
        preflight: jest.fn().mockRejectedValue(new Error('PRIVATE_HOST_PREFLIGHT')),
      })).rejects.toThrow('PRIVATE_HOST_PREFLIGHT');
      expect(onPreflightStage.mock.calls).toEqual([['artifact-preflight'], ['host-preflight']]);
    } finally {
      runPreflight.mockRestore();
      trustedTool.mockRestore();
      reap.mockRestore();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
});
