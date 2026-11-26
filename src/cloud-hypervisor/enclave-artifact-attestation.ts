import { constants, promises as fs } from 'fs';
import execa from 'execa';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder } from 'util';
import {
  CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
  CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
} from './artifact-manifest';
import { assertTrustedRegularFile, calculateSha256 } from './artifact-trust';
import {
  enclaveRootfsArtifactForRole,
  type CloudHypervisorEnclaveArtifactManifest,
  type CloudHypervisorEnclaveRole,
} from './enclave-artifact-manifest';
import { checkEnclaveArtifact as check, enclaveArtifactPath as filePath } from './enclave-artifact-trust-checks';
import type { VerifiedCloudHypervisorEnclaveArtifacts } from './enclave-executor-types';
import {
  HostPreflightCleanupError, HostPreflightReporter, markHostPreflightError,
} from './host-preflight-progress';

export async function verifyEnclaveArtifactAttestation(
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
    throw markHostPreflightError(
      new Error(`Enclave artifact attestation verification failed: ${result.stderr.trim()}`),
      'attestation-failed',
    );
  }
}

export async function readTrustedArtifactBytes(
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
      throw markHostPreflightError(new Error('Trusted enclave artifact has invalid file metadata'), 'file-type');
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
      throw markHostPreflightError(new Error('Trusted enclave artifact has invalid content size'), 'artifact-size');
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function writeEnclaveArtifactVerificationFiles(
  verificationDirectory: string,
  manifestBytes: Buffer,
  bundleBytes: Buffer,
): Promise<{ manifestPath: string; bundlePath: string }> {
  const manifestPath = path.join(verificationDirectory, 'manifest.json');
  const bundlePath = path.join(
    verificationDirectory,
    'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
  );
  await fs.writeFile(manifestPath, manifestBytes, { flag: 'wx', mode: 0o400 });
  await fs.writeFile(bundlePath, bundleBytes, { flag: 'wx', mode: 0o400 });
  return { manifestPath, bundlePath };
}

export function createEnclaveArtifactVerificationDirectory(root?: string): Promise<string> {
  return fs.mkdtemp(path.join(root ?? os.tmpdir(), 'awf-enclave-attestation-'));
}

interface EnclaveArtifactVerification {
  uid: number;
  manifestDir: string;
  manifest: CloudHypervisorEnclaveArtifactManifest;
  rootfsPaths: Record<CloudHypervisorEnclaveRole, string>;
  verificationDirectory: string;
  attestationToolPath: string;
  copyRootfs?: (source: string, destination: string) => Promise<void>;
  roleReports: Record<CloudHypervisorEnclaveRole, HostPreflightReporter | undefined>;
}

async function verifyRootfsForRole(
  context: EnclaveArtifactVerification,
  role: CloudHypervisorEnclaveRole,
): Promise<void> {
  const { uid, manifestDir, manifest, rootfsPaths, verificationDirectory, attestationToolPath,
    copyRootfs, roleReports } = context;
  const sharedRootfs = manifest.rootfs.script.file === manifest.rootfs.agent.file;
  const roleReport = roleReports[role];
  const artifact = manifest.rootfs[role];
  const rootfsPath = rootfsPaths[role];
  const provenanceName = sharedRootfs
    ? 'enclave-rootfs.provenance.sigstore.jsonl'
    : `${artifact.file.replace(/\.ext4$/, '')}.provenance.sigstore.jsonl`;
  const provenance = filePath(manifestDir, provenanceName);
  await check(roleReport, 'rootfs-trust', () =>
    assertTrustedRegularFile(`${role} enclave rootfs`, rootfsPath, constants.R_OK, {
      uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
    }));
  await check(roleReport, 'rootfs-provenance-trust', async () => {
    await assertTrustedRegularFile(`${role} enclave rootfs provenance`, provenance, constants.R_OK, {
      uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
    });
    if ((await fs.lstat(provenance)).size > 8 * 1024 * 1024) {
      throw markHostPreflightError(new Error(`${role} enclave rootfs provenance exceeds its size limit`),
        'artifact-size');
    }
  });
  const rootfsStat = await fs.lstat(rootfsPath);
  const roleDirectory = path.join(verificationDirectory, sharedRootfs ? 'shared' : role);
  if (copyRootfs) await fs.mkdir(roleDirectory, { mode: 0o700 });
  let verifiedRootfs = rootfsPath;
  let verifiedProvenance = provenance;
  if (copyRootfs) {
    verifiedRootfs = path.join(roleDirectory, artifact.file);
    verifiedProvenance = path.join(roleDirectory, path.basename(provenance));
    await check(roleReport, 'rootfs-copy', () => copyRootfs(rootfsPath, verifiedRootfs));
    await fs.chmod(verifiedRootfs, 0o400);
    await fs.writeFile(verifiedProvenance, await readTrustedArtifactBytes(provenance, uid, 8 * 1024 * 1024),
      { flag: 'wx', mode: 0o400 });
  }
  await check(roleReport, 'rootfs-digest', async () => {
    if (rootfsStat.size !== artifact.sizeBytes
      || (await fs.lstat(verifiedRootfs)).size !== artifact.sizeBytes
      || await calculateSha256(verifiedRootfs) !== artifact.sha256) {
      throw markHostPreflightError(
        new Error(`${role} enclave rootfs does not match its trusted manifest digest and size`),
        'digest-mismatch');
    }
  });
  await check(roleReport, 'rootfs-attestation', () =>
    verifyEnclaveArtifactAttestation(attestationToolPath, verifiedRootfs, verifiedProvenance));
  if (copyRootfs) await fs.rm(roleDirectory, { recursive: true, force: true });
}

async function verifySbomForRole(
  context: EnclaveArtifactVerification,
  role: CloudHypervisorEnclaveRole,
): Promise<void> {
  const { uid, manifestDir, manifest, verificationDirectory, copyRootfs, roleReports } = context;
  const artifact = enclaveRootfsArtifactForRole(manifest, role);
  const sbom = filePath(manifestDir, artifact.sbom.file);
  const roleReport = roleReports[role];
  await check(roleReport, 'sbom-trust', async () => {
    await assertTrustedRegularFile(`${role} enclave rootfs SBOM`, sbom, constants.R_OK, {
      uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
    });
    if ((await fs.lstat(sbom)).size > 16 * 1024 * 1024) {
      throw markHostPreflightError(new Error(`${role} enclave rootfs SBOM exceeds its size limit`), 'artifact-size');
    }
  });
  const roleDirectory = path.join(verificationDirectory, `${role}-sbom`);
  if (copyRootfs) await fs.mkdir(roleDirectory, { mode: 0o700 });
  let sbomFailure: { error: unknown } | undefined;
  try {
    let verifiedSbom = sbom;
    if (copyRootfs) {
      verifiedSbom = path.join(roleDirectory, path.basename(sbom));
      await fs.writeFile(verifiedSbom, await readTrustedArtifactBytes(sbom, uid, 16 * 1024 * 1024),
        { flag: 'wx', mode: 0o400 });
    }
    await check(roleReport, 'sbom-digest', async () => {
      if (await calculateSha256(verifiedSbom) !== artifact.sbom.sha256) {
        throw markHostPreflightError(new Error(`${role} enclave rootfs SBOM does not match its trusted manifest digest`),
          'digest-mismatch');
      }
    });
    if (manifest.schemaVersion === 2) {
      await check(roleReport, 'sbom-contents', async () => {
        const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
          .decode(await readTrustedArtifactBytes(verifiedSbom, uid, 16 * 1024 * 1024)));
        const sbom = document as {
          spdxVersion?: unknown;
          packages?: Array<{ SPDXID?: string; checksums?: Array<{ algorithm?: string; checksumValue?: string }> }>;
          files?: unknown[];
        } | null;
        if (sbom?.spdxVersion !== 'SPDX-2.3'
          || !Array.isArray(sbom.files) || sbom.files.length === 0
          || !Array.isArray(sbom.packages)
          || sbom.packages.filter(pkg => pkg?.SPDXID === 'SPDXRef-Rootfs'
            && pkg.checksums?.some(check => check?.algorithm === 'SHA256'
              && check.checksumValue === artifact.sha256)).length !== 1) {
          throw markHostPreflightError(
            new Error(`${role} enclave rootfs SBOM does not bind its final filesystem digest`),
            'digest-mismatch');
        }
      });
    } else {
      roleReport?.notRequired('sbom-contents');
    }
  } catch (error) {
    sbomFailure = { error };
  }
  if (copyRootfs) {
    try {
      await fs.rm(roleDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (sbomFailure) throw new HostPreflightCleanupError(sbomFailure.error, cleanupError);
      throw cleanupError;
    }
  }
  if (sbomFailure) throw sbomFailure.error;
}

export async function verifyEnclaveRootfsArtifacts(
  context: EnclaveArtifactVerification,
): Promise<VerifiedCloudHypervisorEnclaveArtifacts['rootfs']> {
  const { manifest, rootfsPaths } = context;
  const sharedRootfs = manifest.rootfs.script.file === manifest.rootfs.agent.file;
  for (const role of ['script', 'agent'] as const) {
    if (sharedRootfs && role === 'agent') continue;
    await verifyRootfsForRole(context, role);
  }
  for (const role of ['script', 'agent'] as const) {
    if (sharedRootfs && role === 'agent'
      && manifest.rootfs.script.sbom.file === manifest.rootfs.agent.sbom.file) continue;
    await verifySbomForRole(context, role);
  }
  return {
    script: { path: rootfsPaths.script, artifact: manifest.rootfs.script },
    agent: { path: rootfsPaths.agent, artifact: manifest.rootfs.agent },
  };
}
