import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } from './artifact-manifest';
import * as artifactTrust from './artifact-trust';
import { HostPreflightReporter, type HostPreflightCheck, type HostPreflightProgress } from './host-preflight-progress';
import {
  preflightCloudHypervisorEnclaveArtifacts,
} from './host-enclave-executor';
import {
  assertEnclaveStartupChecklistComplete, getEnclaveStartupProgress, updateEnclaveStartupProgress,
} from '../enclave/startup-progress';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { schema as preflightSchema } from './host-preflight-schema';
import { createExecutorScratchDirectory } from './host-enclave-executor.test-utils';

describe('Cloud Hypervisor host enclave artifact preflight', () => {
  it('rejects artifact preflight when the attestation tool is not trusted', async () => {
    await expect(preflightCloudHypervisorEnclaveArtifacts({
      releaseTag: 'v0.23.1',
      manifestPath: '/trusted/cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
      manifestBundlePath: '/trusted/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      scriptRootfsPath: '/trusted/enclave-script-rootfs.ext4',
      agentRootfsPath: '/trusted/enclave-agent-rootfs.ext4',
      attestationToolPath: '/missing/gh',
    })).rejects.toThrow();
  });

  it.each([true, false])('verifies a release-pinned artifact set and rejects a rootfs digest mismatch (shared=%s)', async (shared) => {
    const scratch = await createExecutorScratchDirectory('.awf-enclave-preflight-');
    const releaseTag = CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG;
    const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');
    const writeTrustedFile = async (name: string, contents: string): Promise<string> => {
      const filePath = path.join(scratch, name);
      await fs.writeFile(filePath, contents, { mode: 0o400 });
      return filePath;
    };
    const scriptRootfs = shared ? 'shared-rootfs-fixture' : 'script-rootfs-fixture';
    const agentRootfs = shared ? scriptRootfs : 'agent-rootfs-fixture';
    const scriptSbom = JSON.stringify({ name: 'enclave-script' });
    const agentSbom = JSON.stringify({ name: 'enclave-agent' });
    const artifacts = (role: 'script' | 'agent', rootfs: string, sbom: string) => {
      const digest = 'a'.repeat(64);
      return {
        file: shared ? 'enclave-rootfs.ext4' : `enclave-${role}-rootfs.ext4`,
        role,
        version: releaseTag,
        sha256: hash(rootfs),
        sizeBytes: Buffer.byteLength(rootfs),
        uid: 65534,
        gid: 65534,
        entrypoint: `/usr/local/bin/run-enclave-${role}`,
        sourceImage: `ghcr.io/github/gh-aw-firewall/${shared ? 'cloud-hypervisor-enclave' : `enclave-${role}`}@sha256:${digest}`,
        sourceImageDigest: digest,
        sbom: {
          file: `enclave-${role}-rootfs.sbom.spdx.json`,
          sha256: hash(sbom),
        },
      };
    };
    const scriptArtifact = artifacts('script', scriptRootfs, scriptSbom);
    const agentArtifact = artifacts('agent', agentRootfs, agentSbom);
    const manifestPath = path.join(scratch, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json');
    const scriptRootfsPath = await writeTrustedFile(scriptArtifact.file, scriptRootfs);
    const agentRootfsPath = shared ? scriptRootfsPath : await writeTrustedFile(agentArtifact.file, agentRootfs);
    await writeTrustedFile(scriptArtifact.sbom.file, scriptSbom);
    await writeTrustedFile(agentArtifact.sbom.file, agentSbom);
    const manifestBundlePath = await writeTrustedFile(
      'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      '{"fixture":"signed"}\n',
    );
    const manifestBundle = '{"fixture":"signed"}\n';
    const attestationTracePath = path.join(scratch, 'attestation-arguments');
    const attestationToolPath = await writeTrustedFile('gh',
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${attestationTracePath}'\nprintf '\\n' >> '${attestationTracePath}'\n`);
    await fs.chmod(attestationToolPath, 0o700);
    const rootfsProvenancePath = await writeTrustedFile(
      shared ? 'enclave-rootfs.provenance.sigstore.jsonl' : 'enclave-script-rootfs.provenance.sigstore.jsonl',
      '{"fixture":"shared"}\n',
    );
    if (!shared) await writeTrustedFile('enclave-agent-rootfs.provenance.sigstore.jsonl', '{"fixture":"agent"}\n');
    await fs.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
      architecture: 'x86_64',
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: releaseTag,
        sourceCommit: 'b'.repeat(40),
      },
      compatibility: {
        cloudHypervisorVersion: '53.0',
        kernelVersion: '6.1.141',
        supervisorVersion: releaseTag,
      },
      ...(shared ? { guestBase: {
        image: `ghcr.io/github/gh-aw-firewall/cloud-hypervisor-guest-base@sha256:${'a'.repeat(64)}`,
        imageId: `sha256:${'a'.repeat(64)}`,
      } } : {}),
      rootfs: { script: scriptArtifact, agent: agentArtifact },
    }), { mode: 0o400 });
    const toolTrust = jest.spyOn(artifactTrust, 'assertTrustedHostTool').mockResolvedValue();

    const artifactChecks = [
      'operator-identity', 'tool-gh', 'verification-directory', 'enclave-artifacts',
      'manifest-bundle-path', 'manifest-trust', 'bundle-trust', 'manifest-read', 'bundle-read',
      'manifest-parse', 'manifest-attestation', 'rootfs-configuration',
      'rootfs-trust', 'rootfs-provenance-trust', 'rootfs-digest', 'rootfs-attestation',
      'sbom-trust', 'sbom-digest', 'sbom-contents',
    ];
    const wrapper = { enclaves: normalizeEnclavesConfig([{ script: {}, repos: [] }]) } as WrapperConfig;
    const publish = (hostPreflight: HostPreflightProgress) =>
      updateEnclaveStartupProgress(wrapper, { hostPreflight });
    const admission = new HostPreflightReporter('bounded-artifacts', publish, undefined,
      { phase: 'preflight', profile: 'common' });
    for (const id of Object.keys(preflightSchema.scopes['bounded-artifacts']) as HostPreflightCheck[]) {
      // Storage admission is a fixture here; artifact verification below uses real files.
      if (!artifactChecks.includes(id)) await admission.check(id, () => undefined);
    }
    const assertArtifactsComplete = async (version: 1 | 2) => {
      const checks = getEnclaveStartupProgress(wrapper)!.startupChecks!.checks;
      for (const id of artifactChecks) {
        expect(checks[`bounded-artifacts/${id}`]).toEqual([
          id === 'sbom-contents' && version === 1 ? 'not-required' : 'passed', 'none',
        ]);
      }
      expect(Object.values(checks).every(([result]) => result === 'passed' || result === 'not-required')).toBe(true);
      const startup = new HostPreflightReporter('startup', publish);
      for (const id of Object.keys(preflightSchema.scopes.startup) as HostPreflightCheck[]) {
        if (id !== 'readiness') await startup.check(id, () => undefined);
      }
      await startup.check('readiness', () => assertEnclaveStartupChecklistComplete(wrapper, true));
      expect(() => assertEnclaveStartupChecklistComplete(wrapper)).not.toThrow();
    };
    try {
      await expect(admission.check('enclave-artifacts', () => preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      }, undefined, undefined, admission))).resolves.toMatchObject({
        rootfs: {
          script: { path: scriptRootfsPath, artifact: scriptArtifact },
          agent: { path: agentRootfsPath, artifact: agentArtifact },
        },
      });
      await assertArtifactsComplete(1);
      const verifications = (await fs.readFile(attestationTracePath, 'utf8')).trim().split('\n\n')
        .map((invocation) => invocation.split('\n'));
      expect(verifications).toHaveLength(shared ? 2 : 3);
      for (const args of verifications) {
        expect(args.slice(0, 2)).toEqual(['attestation', 'verify']);
        expect(args.slice(3)).toEqual([
          '--repo', 'github/gh-aw-firewall',
          '--bundle', expect.any(String),
          '--signer-workflow', 'github/gh-aw-firewall/.github/workflows/release.yml',
          '--deny-self-hosted-runners',
        ]);
      }
      expect(verifications[1][2]).toBe(scriptRootfsPath);
      expect(verifications[1][6]).toBe(rootfsProvenancePath);
      const copyProgress: HostPreflightProgress[] = [];
      const copyReport = new HostPreflightReporter('bounded-artifacts', value => copyProgress.push(value),
        undefined, { phase: 'preflight', profile: 'common' });
      const copyOptions = { releaseTag, manifestPath, manifestBundlePath,
        scriptRootfsPath, agentRootfsPath, attestationToolPath };
      await expect(preflightCloudHypervisorEnclaveArtifacts(copyOptions, scratch,
        async () => { throw Object.assign(new Error('/private/SECRET'), { code: 'ENOSPC' }); },
        copyReport)).rejects.toMatchObject({ code: 'ENOSPC' });
      const failedCopy = copyProgress[copyProgress.length - 1];
      expect(failedCopy).toMatchObject({ schemaVersion: 2, scope: 'bounded-artifacts' });
      expect(failedCopy.checks.find(check => check.id === 'rootfs-copy'))
        .toEqual({ id: 'rootfs-copy', result: 'failed', reason: 'ENOSPC' });
      expect(failedCopy.checks.find(check => check.id === 'rootfs-digest')?.result).toBe('not-attempted');
      expect(failedCopy.checks.find(check => check.id === 'rootfs-attestation')?.result).toBe('not-attempted');
      expect(JSON.stringify(copyProgress)).not.toContain('SECRET');
      expect((await fs.readdir(scratch)).filter(name => name.startsWith('awf-enclave-attestation-'))).toEqual([]);
      const progress = jest.fn();
      const report = new HostPreflightReporter('bounded-artifacts', progress, undefined,
        { phase: 'preflight', profile: 'common' });
      const cleanupError = Object.assign(new Error('cleanup PRIVATE_SENTINEL'), { code: 'EIO' });
      const remove = fs.rm.bind(fs);
      const cleanup = jest.spyOn(fs, 'rm').mockImplementation(async (destination, options) => {
        if (String(destination).includes('awf-enclave-attestation-')) throw cleanupError;
        return remove(destination, options);
      });
      try {
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          releaseTag, manifestPath, manifestBundlePath, scriptRootfsPath, agentRootfsPath,
          rootfsPath: path.join(scratch, 'wrong-rootfs'), attestationToolPath,
        }, scratch, undefined, report)).rejects.toMatchObject({
          cause: expect.any(Error), cleanupError,
        });
        const record = progress.mock.calls.map(([value]) => value)
          .find((value) => value.checks.some((check: { id: string; result: string }) =>
            check.id === 'rootfs-configuration' && check.result === 'failed'));
        expect(record).toMatchObject({
          schemaVersion: 2, phase: 'preflight', profile: 'common',
        });
        expect(record.checks.find((check: { id: string }) => check.id === 'rootfs-configuration').reason)
          .toBe('requirement-not-met');
        expect(JSON.stringify(progress.mock.calls)).not.toContain('PRIVATE_SENTINEL');
      } finally {
        cleanup.mockRestore();
      }
      if (shared) {
        const originalManifest = await fs.readFile(manifestPath, 'utf8');
        const v2 = JSON.parse(originalManifest) as Record<string, unknown>;
        const sharedArtifact: Record<string, unknown> = { ...scriptArtifact };
        delete sharedArtifact.role;
        delete sharedArtifact.entrypoint;
        const inventory = JSON.stringify({
          spdxVersion: 'SPDX-2.3',
          packages: [{ SPDXID: 'SPDXRef-Rootfs', checksums: [
            { algorithm: 'SHA256', checksumValue: hash(scriptRootfs) },
          ] }],
          files: [{ fileName: './etc/passwd' }],
        });
        await writeTrustedFile('enclave-rootfs.sbom.spdx.json', inventory);
        v2.schemaVersion = 2;
        v2.entrypoints = {
          script: '/usr/local/bin/run-enclave-script',
          agent: '/usr/local/bin/run-enclave-agent',
        };
        v2.rootfs = {
          ...sharedArtifact, sourceImageId: `sha256:${'c'.repeat(64)}`,
          sbom: { file: 'enclave-rootfs.sbom.spdx.json', sha256: hash(inventory) },
        };
        await fs.chmod(manifestPath, 0o600);
        await fs.writeFile(manifestPath, JSON.stringify(v2));
        await fs.chmod(manifestPath, 0o400);
        const canonical = {
          releaseTag, manifestPath, manifestBundlePath,
          rootfsPath: scriptRootfsPath, attestationToolPath,
        };
        await expect(admission.check('enclave-artifacts', () =>
          preflightCloudHypervisorEnclaveArtifacts(canonical, undefined, undefined, admission)))
          .resolves.toMatchObject({
            rootfs: {
              script: { path: scriptRootfsPath },
              agent: { path: scriptRootfsPath },
            },
          });
        await assertArtifactsComplete(2);
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          ...canonical, rootfsPath: undefined,
          scriptRootfsPath, agentRootfsPath,
        })).rejects.toThrow('Canonical enclave rootfs path is required');
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          ...canonical, agentRootfsPath: path.join(scratch, 'wrong-rootfs'),
        })).rejects.toThrow('does not match the trusted manifest path');
        await fs.chmod(manifestPath, 0o600);
        await fs.writeFile(manifestPath, originalManifest);
        await fs.chmod(manifestPath, 0o400);
      } else {
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          releaseTag, manifestPath, manifestBundlePath,
          rootfsPath: scriptRootfsPath, scriptRootfsPath, agentRootfsPath, attestationToolPath,
        })).rejects.toThrow('does not match the trusted manifest path');
      }

      const verificationRoot = path.join(scratch, 'bounded');
      await fs.mkdir(verificationRoot, { mode: 0o700 });
      await fs.writeFile(attestationTracePath, '');
      const contentTrace = path.join(scratch, 'attested-content');
      await fs.writeFile(attestationToolPath,
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${attestationTracePath}'\nprintf '\\n' >> '${attestationTracePath}'\ncat "$3" >> '${contentTrace}'\n`);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag, manifestPath, manifestBundlePath, scriptRootfsPath, agentRootfsPath, attestationToolPath,
      }, verificationRoot, async (source, destination) => {
        await fs.copyFile(source, destination);
        // Replace the operator source after capture but before hashing/attestation.
        await fs.chmod(source, 0o600);
        await fs.writeFile(source, 'replaced-after-capture');
        await fs.chmod(source, 0o400);
      })).resolves.toMatchObject({
        rootfs: { script: { artifact: scriptArtifact }, agent: { artifact: agentArtifact } },
      });
      const capturedAttestations = (await fs.readFile(attestationTracePath, 'utf8')).trim().split('\n\n')
        .map((invocation) => invocation.split('\n'));
      for (const args of capturedAttestations) {
        expect(args[2].startsWith(`${verificationRoot}/`)).toBe(true);
        expect(args[6].startsWith(`${verificationRoot}/`)).toBe(true);
      }
      const attestedContent = await fs.readFile(contentTrace, 'utf8');
      expect(attestedContent).toContain(scriptRootfs);
      expect(attestedContent).toContain(agentRootfs);
      expect(attestedContent).not.toContain('replaced-after-capture');
      expect(await fs.readdir(verificationRoot)).toEqual([]);
      await fs.chmod(scriptRootfsPath, 0o600);
      await fs.writeFile(scriptRootfsPath, scriptRootfs);
      await fs.chmod(scriptRootfsPath, 0o400);
      if (!shared) {
        await fs.chmod(agentRootfsPath, 0o600);
        await fs.writeFile(agentRootfsPath, agentRootfs);
        await fs.chmod(agentRootfsPath, 0o400);
      }

      await fs.chmod(manifestBundlePath, 0o600);
      await fs.writeFile(manifestBundlePath, '');
      await fs.chmod(manifestBundlePath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('Trusted enclave artifact has invalid file metadata');
      await fs.chmod(manifestBundlePath, 0o600);
      await fs.writeFile(manifestBundlePath, manifestBundle);
      await fs.chmod(manifestBundlePath, 0o400);

      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath: path.join(scratch, 'wrong-bundle'),
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('must use its fixed release filename');
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath: path.join(scratch, 'wrong-rootfs'),
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('does not match the trusted manifest path');

      await fs.chmod(rootfsProvenancePath, 0o600);
      await fs.truncate(rootfsProvenancePath, 8 * 1024 * 1024 + 1);
      await fs.chmod(rootfsProvenancePath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('provenance exceeds its size limit');

      await fs.chmod(rootfsProvenancePath, 0o600);
      await fs.writeFile(rootfsProvenancePath, '{"fixture":"shared"}\n');
      await fs.chmod(rootfsProvenancePath, 0o400);
      const agentSbomPath = path.join(scratch, agentArtifact.sbom.file);
      await fs.chmod(agentSbomPath, 0o600);
      await fs.truncate(agentSbomPath, 16 * 1024 * 1024 + 1);
      await fs.chmod(agentSbomPath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('SBOM exceeds its size limit');

      await fs.writeFile(attestationToolPath, '#!/bin/sh\nexit 1\n');
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('attestation verification failed');
      await fs.writeFile(attestationToolPath, '#!/bin/sh\nexit 0\n');

      await fs.chmod(agentSbomPath, 0o600);
      await fs.writeFile(agentSbomPath, 'tampered-sbom');
      await fs.chmod(agentSbomPath, 0o400);
      await expect(admission.check('enclave-artifacts', () => preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      }, undefined, undefined, admission))).rejects.toThrow('SBOM does not match its trusted manifest digest');
      expect(getEnclaveStartupProgress(wrapper)!.startupChecks).toMatchObject({
        ready: false,
        checks: {
          'bounded-artifacts/sbom-digest': ['failed', 'digest-mismatch'],
          'bounded-artifacts/enclave-artifacts': ['failed', 'digest-mismatch'],
        },
      });
      expect(() => assertEnclaveStartupChecklistComplete(wrapper)).toThrow(/incomplete required checks/);

      await fs.chmod(scriptRootfsPath, 0o600);
      await fs.writeFile(scriptRootfsPath, 'tampered-rootfs');
      await fs.chmod(scriptRootfsPath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('does not match its trusted manifest digest and size');
    } finally {
      toolTrust.mockRestore();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});
