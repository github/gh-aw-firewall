import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CloudHypervisorHostEnclaveExecutorBackend,
  readBoundedCloudHypervisorEnclaveResult,
} from './host-enclave-executor';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type {
  CloudHypervisorHostToolPaths,
  CloudHypervisorPreflightResult,
} from './preflight';
import type { VerifiedCloudHypervisorEnclaveArtifacts } from './host-enclave-executor';

describe('readBoundedCloudHypervisorEnclaveResult', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-result-'));
  });

  describe('CloudHypervisorHostEnclaveExecutorBackend', () => {
    it('stages a static invocation, stops the VM before reading its bounded result, and cleans storage', async () => {
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-host-backend-'));
      const root = await fs.realpath(scratch);
      const seedsDir = path.join(root, 'seeds');
      const invocationsDir = path.join(root, 'invocations');
      const seedId = 'c'.repeat(32);
      const entryId = 'script-entry';
      const invocationId = 'd'.repeat(32);
      await fs.mkdir(path.join(seedsDir, seedId), { recursive: true, mode: 0o700 });
      await fs.mkdir(invocationsDir, { mode: 0o700 });

      const runState: HostExecutorRunState = {
        runId: 'a'.repeat(32),
        seedsDir,
        invocationsDir,
        entries: [{
          entryId,
          executorKind: 'script',
          timeoutMs: 60_000,
          staticSeedIds: [seedId],
          dynamicAgents: false,
        }],
      };
      const invocationHostDir = path.join(invocationsDir, entryId, invocationId);
      const plan: HostExecutorInvocationPlan = {
        runId: runState.runId,
        entryId,
        invocationId,
        executorKind: 'script',
        timeoutMs: 60_000,
        requestHash: 'e'.repeat(64),
        admissionId: 'f'.repeat(32),
        schemaHash: '1'.repeat(64),
        schema: { type: 'boolean' },
        payload: 'print(True)',
        invocationHostDir,
        seedId,
        seedHostPath: path.join(seedsDir, seedId),
      };

      const tools = {
        rsync: '/usr/bin/rsync',
        mount: '/usr/bin/mount',
        umount: '/usr/bin/umount',
      } as CloudHypervisorHostToolPaths;
      const preflight = {
        cloudHypervisorBinary: '/trusted/cloud-hypervisor',
        virtiofsdBinary: '/trusted/virtiofsd',
        kernelPath: '/trusted/vmlinux',
        rootfsPath: '/trusted/primary-rootfs',
        supervisorPath: '/trusted/supervisor',
        artifactSnapshotDirectory: '/trusted/preflight',
        artifactDigests: {
          cloudHypervisor: 'a'.repeat(64),
          virtiofsd: 'b'.repeat(64),
          kernel: 'c'.repeat(64),
          rootfs: 'd'.repeat(64),
          supervisor: 'e'.repeat(64),
        },
        tools,
      } as CloudHypervisorPreflightResult;
      const artifact = {
        file: 'enclave-script-rootfs.ext4',
        role: 'script',
        version: 'v0.23.1',
        sha256: 'f'.repeat(64),
        sizeBytes: 4096,
        uid: 65534,
        gid: 65534,
        entrypoint: '/usr/local/bin/run-enclave-script',
        sourceImage: 'ghcr.io/github/gh-aw-firewall/enclave-script@sha256:' + 'a'.repeat(64),
        sourceImageDigest: 'a'.repeat(64),
        sbom: { file: 'enclave-script-rootfs.sbom.spdx.json', sha256: 'b'.repeat(64) },
      };
      const artifacts = {
        manifest: {
          release: { tag: 'v0.23.1' },
          rootfs: {
            script: { entrypoint: '/usr/local/bin/run-enclave-script' },
            agent: { entrypoint: '/usr/local/bin/run-enclave-agent' },
          },
        },
        manifestPath: '/trusted/manifest.json',
        manifestBundlePath: '/trusted/manifest.sigstore.jsonl',
        rootfs: {
          script: { path: '/trusted/enclave-script-rootfs.ext4', artifact },
          agent: { path: '/trusted/enclave-agent-rootfs.ext4', artifact: { ...artifact, role: 'agent' } },
        },
      } as unknown as VerifiedCloudHypervisorEnclaveArtifacts;
      const config: CloudHypervisorOptions = {
        previewEnabled: true,
        mountPolicy: 'workspace-only',
        cloudHypervisorBinary: '/trusted/cloud-hypervisor',
        artifactReleaseTag: 'v0.23.1',
        vcpuCount: 1,
        memoryMib: 768,
        apiTimeoutMs: 30_000,
      };
      const uid = process.getuid?.() || 1000;
      const gid = process.getgid?.() || 1000;
      let stopped = false;
      let unmounted = false;
      let snapshotRemoved = false;
      const backend = new CloudHypervisorHostEnclaveExecutorBackend({
        runState,
        config,
        workDir: root,
        preflight,
        enclaveArtifacts: artifacts,
      }, {
        createArtifactSnapshot: async () => ({
          directory: path.join(root, 'snapshot'),
          cloudHypervisorBinary: '/snapshot/cloud-hypervisor',
          virtiofsdBinary: '/snapshot/virtiofsd',
          kernelPath: '/snapshot/vmlinux',
          rootfsPath: '/snapshot/rootfs.ext4',
          supervisorPath: '/snapshot/supervisor',
        }),
        copySparseFile: async () => undefined,
        removeArtifactSnapshot: async () => { snapshotRemoved = true; },
        mountTmpfs: async () => undefined,
        unmount: async () => { unmounted = true; },
        resolveIdentity: () => ({ uid, gid }),
        createManager: (_config, _workDir, profile) => ({
          start: async () => undefined,
          startInstance: async () => undefined,
          execute: async () => {
            const output = profile.guest?.exports.find(({ tag }) => tag === 'enclave-output')?.source;
            if (!output) throw new Error('expected the trusted output export');
            await fs.writeFile(path.join(output, 'out'), 'false');
            return { exitCode: 0, signal: null, timedOut: false };
          },
          cancel: async () => undefined,
          stop: async () => {
            stopped = true;
            const output = path.join(invocationHostDir, 'output', 'out');
            await fs.writeFile(output, 'true');
          },
          completeCleanupRecord: async () => undefined,
        }),
      });

      try {
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'success', result: 'true' });
        expect(stopped).toBe(true);
        expect(snapshotRemoved).toBe(true);
        expect(unmounted).toBe(true);
        await expect(fs.lstat(invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await backend.close();
        await fs.rm(scratch, { recursive: true, force: true });
      }
    });
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns canonical schema-validated JSON within the byte bound', async () => {
    const output = path.join(directory, 'out');
    await fs.writeFile(output, '{"count":2,"ok":true}');
    const schema: FiniteSchemaNode = {
      type: 'object',
      fields: [
        { name: 'ok', schema: { type: 'boolean' } },
        { name: 'count', schema: { type: 'integer', minimum: 0, maximum: 4 } },
      ],
    };

    await expect(readBoundedCloudHypervisorEnclaveResult(output, schema, 64))
      .resolves.toBe('{"ok":true,"count":2}');
  });

  it.each([
    ['invalid JSON', '{'],
    ['schema mismatch', '{"ok":"yes"}'],
    ['empty result', ''],
  ])('rejects %s', async (_label, contents) => {
    const output = path.join(directory, 'out');
    await fs.writeFile(output, contents);
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();
  });

  it('rejects oversized, invalid UTF-8, and symlinked results', async () => {
    const output = path.join(directory, 'out');
    await fs.writeFile(output, 'true ');
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      4,
    )).resolves.toBeUndefined();

    await fs.writeFile(output, Buffer.from([0xff]));
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();

    const target = path.join(directory, 'target');
    await fs.writeFile(target, 'true');
    await fs.rm(output);
    await fs.symlink(target, output);
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();
  });
});
