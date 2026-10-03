import { constants, promises as fs } from 'fs';
import execa from 'execa';
import * as os from 'os';
import { TextDecoder } from 'util';
import * as path from 'path';
import {
  CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
  CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
} from './artifact-manifest';
import {
  assertTrustedHostTool,
  assertTrustedRegularFile,
  calculateSha256,
  resolveTrustedOperatorUid,
} from './artifact-trust';
import {
  enclaveRootfsArtifactForRole,
  parseCloudHypervisorEnclaveArtifactManifest,
  type CloudHypervisorEnclaveRootfsArtifact,
  type CloudHypervisorEnclaveRole,
} from './enclave-artifact-manifest';
import type {
  CloudHypervisorEnclaveArtifactPreflightOptions,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';

function filePath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

async function verifyAttestation(
  executable: string,
  subject: string,
  bundle: string,
): Promise<void> {
  // The executable is resolved and ownership-verified before this helper is called.
  // eslint-disable-next-line local/no-unsafe-execa
  const result = await execa(executable, [
    'attestation', 'verify', subject,
    '--repo', CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
    '--bundle', bundle,
    '--signer-workflow', CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
    '--deny-self-hosted-runners',
  ], {
    reject: false,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Enclave artifact attestation verification failed: ${result.stderr.trim()}`);
  }
}

async function readTrustedArtifactBytes(
  filePathValue: string,
  uid: number,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(
    filePathValue,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maxBytes ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== 0 && stat.uid !== uid)
    ) {
      throw new Error('Trusted enclave artifact has invalid file metadata');
    }
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    let total = 0;
    while (total <= maxBytes) {
      const length = Math.min(chunk.length, maxBytes + 1 - total);
      const { bytesRead } = await handle.read(chunk, 0, length, total);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total < 1 || total > maxBytes) {
      throw new Error('Trusted enclave artifact has invalid content size');
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/**
 * Verifies the release-pinned enclave artifact set before any invocation is
 * admitted: trusted ownership/modes, closed manifest, content digests, and
 * GitHub attestations for the manifest and both role-specific root filesystems.
 */
export async function preflightCloudHypervisorEnclaveArtifacts(
  options: CloudHypervisorEnclaveArtifactPreflightOptions,
): Promise<VerifiedCloudHypervisorEnclaveArtifacts> {
  const uid = resolveTrustedOperatorUid();
  await assertTrustedHostTool('GitHub CLI', options.attestationToolPath);
  const manifestDir = path.dirname(options.manifestPath);
  const expectedBundle = filePath(manifestDir, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
  if (options.manifestBundlePath !== expectedBundle) {
    throw new Error('Enclave artifact manifest bundle must use its fixed release filename');
  }
  await assertTrustedRegularFile('enclave artifact manifest', options.manifestPath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  });
  await assertTrustedRegularFile('enclave artifact manifest bundle', options.manifestBundlePath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  });
  const manifestBytes = await readTrustedArtifactBytes(options.manifestPath, uid, 1024 * 1024);
  const bundleBytes = await readTrustedArtifactBytes(options.manifestBundlePath, uid, 8 * 1024 * 1024);
  const verificationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-attestation-'));
  try {
    const verifiedManifestPath = path.join(verificationDirectory, 'manifest.json');
    const verifiedBundlePath = path.join(
      verificationDirectory,
      'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
    );
    await fs.writeFile(verifiedManifestPath, manifestBytes, { flag: 'wx', mode: 0o400 });
    await fs.writeFile(verifiedBundlePath, bundleBytes, { flag: 'wx', mode: 0o400 });
    const manifest = parseCloudHypervisorEnclaveArtifactManifest(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
      options.releaseTag,
    );
    await verifyAttestation(options.attestationToolPath, verifiedManifestPath, verifiedBundlePath);

    const rootfs: Record<CloudHypervisorEnclaveRole, {
      path: string;
      artifact: CloudHypervisorEnclaveRootfsArtifact;
    }> = {
      script: { path: '', artifact: manifest.rootfs.script },
      agent: { path: '', artifact: manifest.rootfs.agent },
    };
    for (const role of ['script', 'agent'] as const) {
      const artifact = enclaveRootfsArtifactForRole(manifest, role);
      const expectedRootfs = filePath(manifestDir, artifact.file);
      const provenance = filePath(manifestDir, `enclave-${role}-rootfs.provenance.sigstore.jsonl`);
      const sbom = filePath(manifestDir, artifact.sbom.file);
      const configuredPath = role === 'script'
        ? options.scriptRootfsPath
        : options.agentRootfsPath;
      if (configuredPath !== expectedRootfs) {
        throw new Error(`Configured ${role} enclave rootfs does not match the trusted manifest path`);
      }
      for (const [label, file] of [
        [`${role} enclave rootfs`, expectedRootfs],
        [`${role} enclave rootfs provenance`, provenance],
        [`${role} enclave rootfs SBOM`, sbom],
      ] as const) {
        await assertTrustedRegularFile(label, file, constants.R_OK, {
          uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
        });
      }
      const rootfsStat = await fs.lstat(expectedRootfs);
      if ((await fs.lstat(provenance)).size > 8 * 1024 * 1024 ||
        (await fs.lstat(sbom)).size > 16 * 1024 * 1024) {
        throw new Error(`${role} enclave rootfs provenance or SBOM exceeds its size limit`);
      }
      if (rootfsStat.size !== artifact.sizeBytes || await calculateSha256(expectedRootfs) !== artifact.sha256) {
        throw new Error(`${role} enclave rootfs does not match its trusted manifest digest and size`);
      }
      if (await calculateSha256(sbom) !== artifact.sbom.sha256) {
        throw new Error(`${role} enclave rootfs SBOM does not match its trusted manifest digest`);
      }
      await verifyAttestation(options.attestationToolPath, expectedRootfs, provenance);
      if (role === 'script') rootfs.script = { path: expectedRootfs, artifact };
      else rootfs.agent = { path: expectedRootfs, artifact };
    }
    return Object.freeze({
      manifest,
      manifestPath: options.manifestPath,
      manifestBundlePath: options.manifestBundlePath,
      rootfs: Object.freeze(rootfs),
    });
  } finally {
    await fs.rm(verificationDirectory, { recursive: true, force: true });
  }
}

export async function resolveTrustedAttestationTool(environment: NodeJS.ProcessEnv): Promise<string> {
  let lastError: unknown;
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, 'gh');
    try {
      await assertTrustedHostTool('GitHub CLI', candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `A trusted GitHub CLI is required to verify enclave artifact attestations: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? 'not found')
    }`,
  );
}
