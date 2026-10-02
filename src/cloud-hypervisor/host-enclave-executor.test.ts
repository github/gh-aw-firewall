import { createHash } from 'crypto';
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
    it.each([
      { timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success' },
      { timeoutMs: 1_000, startupDelayMs: 1_500, expectedOutcome: 'timeout' },
    ])('stages a static invocation and enforces its $expectedOutcome deadline', async ({
      timeoutMs,
      startupDelayMs,
      expectedOutcome,
    }) => {
      const scratch = await fs.mkdtemp(path.join(os.homedir(), '.awf-host-backend-'));
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
          timeoutMs,
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
        timeoutMs,
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
        sha256: createHash('sha256').update('fixture-rootfs').digest('hex'),
        sizeBytes: Buffer.byteLength('fixture-rootfs'),
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
      let mountedIdentity: { uid: number; gid: number } | undefined;
      let managerBinary: string | undefined;
      const chownedPaths: string[] = [];
      const backend = new CloudHypervisorHostEnclaveExecutorBackend({
        runState,
        config,
        workDir: root,
        preflight,
        enclaveArtifacts: artifacts,
      }, {
        createArtifactSnapshot: async () => {
          const directory = path.join(root, 'snapshot');
          await fs.mkdir(directory, { mode: 0o700 });
          const rootfsPath = path.join(directory, 'rootfs.ext4');
          await fs.writeFile(rootfsPath, 'fixture-rootfs', { mode: 0o400 });
          return {
            directory,
            cloudHypervisorBinary: '/snapshot/cloud-hypervisor',
            virtiofsdBinary: '/snapshot/virtiofsd',
            kernelPath: '/snapshot/vmlinux',
            rootfsPath,
            supervisorPath: '/snapshot/supervisor',
          };
        },
        copySparseFile: async () => undefined,
        removeArtifactSnapshot: async () => { snapshotRemoved = true; },
        mountTmpfs: async (_directory, _size, mountUid, mountGid) => {
          mountedIdentity = { uid: mountUid, gid: mountGid };
        },
        unmount: async () => { unmounted = true; },
        chown: async (filePathValue) => { chownedPaths.push(filePathValue.toString()); },
        resolveIdentity: () => ({ uid, gid }),
        createManager: (managerConfig, _workDir, profile) => {
          managerBinary = managerConfig.cloudHypervisorBinary;
          expect(profile.guest?.identity).toEqual({ uid: 65534, gid: 65534 });
          return {
            start: async () => {
              if (startupDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
              }
            },
            startInstance: async () => undefined,
            execute: async () => {
              const output = profile.guest?.exports.find(({ tag }) => tag === 'enclave-output')?.source;
              if (!output) throw new Error('expected the trusted output export');
              const outputStat = await fs.stat(path.join(output, 'out'));
              expect(outputStat.isFile()).toBe(true);
              expect(outputStat.mode & 0o777).toBe(0o600);
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
          };
        },
      });

      try {
        await expect(backend.execute(plan, new AbortController().signal)).resolves.toEqual(
          expectedOutcome === 'success'
            ? { outcome: 'success', result: 'true' }
            : { outcome: 'timeout' },
        );
        expect(mountedIdentity).toEqual({ uid: 65534, gid: 65534 });
        expect(managerBinary).toBe('/snapshot/cloud-hypervisor');
        expect(chownedPaths).toContain(path.join(invocationHostDir, 'output'));
        expect(chownedPaths).toContain(path.join(invocationHostDir, 'output', 'out'));
        expect(chownedPaths).toContain(path.join(invocationHostDir, 'request', 'query-script.py'));
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
