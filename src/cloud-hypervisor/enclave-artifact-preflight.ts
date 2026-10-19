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
import {
  HostPreflightCleanupError, HostPreflightReporter, markHostPreflightError,
  type HostPreflightCheck,
} from './host-preflight-progress';

function check<T>(
  report: HostPreflightReporter | undefined,
  id: HostPreflightCheck,
  operation: () => Promise<T> | T,
): Promise<T> {
  return report ? report.check(id, operation) : Promise.resolve().then(operation);
}

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
    throw markHostPreflightError(
      new Error(`Enclave artifact attestation verification failed: ${result.stderr.trim()}`),
      'attestation-failed',
    );
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

/**
 * Verifies the release-pinned enclave artifact set before any invocation is
 * admitted: trusted ownership/modes, closed manifest, content digests, and
 * GitHub attestations for the manifest and shared enclave root filesystem.
 */
export async function preflightCloudHypervisorEnclaveArtifacts(
  options: CloudHypervisorEnclaveArtifactPreflightOptions,
  verificationDirectoryRoot?: string,
  copyRootfs?: (source: string, destination: string) => Promise<void>,
  report?: HostPreflightReporter,
): Promise<VerifiedCloudHypervisorEnclaveArtifacts> {
  const uid = await check(report, 'operator-identity', resolveTrustedOperatorUid);
  await check(report, 'tool-gh', () => assertTrustedHostTool('GitHub CLI', options.attestationToolPath));
  const manifestDir = path.dirname(options.manifestPath);
  const expectedBundle = filePath(manifestDir, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
  await check(report, 'manifest-bundle-path', () => {
    if (options.manifestBundlePath !== expectedBundle) {
      throw markHostPreflightError(new Error('Enclave artifact manifest bundle must use its fixed release filename'),
        'requirement-not-met');
    }
  });
  await check(report, 'manifest-trust', () => assertTrustedRegularFile('enclave artifact manifest', options.manifestPath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  }));
  await check(report, 'bundle-trust', () => assertTrustedRegularFile('enclave artifact manifest bundle', options.manifestBundlePath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  }));
  const manifestBytes = await check(report, 'manifest-read', () =>
    readTrustedArtifactBytes(options.manifestPath, uid, 1024 * 1024));
  const bundleBytes = await check(report, 'bundle-read', () =>
    readTrustedArtifactBytes(options.manifestBundlePath, uid, 8 * 1024 * 1024));
  const verificationDirectory = await check(report, 'verification-directory', () => fs.mkdtemp(path.join(
    verificationDirectoryRoot ?? os.tmpdir(), 'awf-enclave-attestation-',
  )));
  let failure: { error: unknown } | undefined;
  let verified: VerifiedCloudHypervisorEnclaveArtifacts | undefined;
  const roleReports = {
    script: report?.fork('bounded-artifacts', { phase: 'preflight', profile: 'script' }),
    agent: report?.fork('bounded-artifacts', { phase: 'preflight', profile: 'agent' }),
  };
  try {
    const verifiedManifestPath = path.join(verificationDirectory, 'manifest.json');
    const verifiedBundlePath = path.join(
      verificationDirectory,
      'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
    );
    await fs.writeFile(verifiedManifestPath, manifestBytes, { flag: 'wx', mode: 0o400 });
    await fs.writeFile(verifiedBundlePath, bundleBytes, { flag: 'wx', mode: 0o400 });
    const manifest = await check(report, 'manifest-parse', () => {
      try {
        return parseCloudHypervisorEnclaveArtifactManifest(
          new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
          options.releaseTag,
        );
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          throw markHostPreflightError(error, 'malformed-json');
        }
        throw error;
      }
    });
    await check(report, 'manifest-attestation', () =>
      verifyAttestation(options.attestationToolPath, verifiedManifestPath, verifiedBundlePath));

    const rootfs: Record<CloudHypervisorEnclaveRole, {
      path: string;
      artifact: CloudHypervisorEnclaveRootfsArtifact;
    }> = {
      script: { path: '', artifact: manifest.rootfs.script },
      agent: { path: '', artifact: manifest.rootfs.agent },
    };
    const rootfsPaths = {
      script: filePath(manifestDir, manifest.rootfs.script.file),
      agent: filePath(manifestDir, manifest.rootfs.agent.file),
    };
    const sharedRootfs = manifest.rootfs.script.file === manifest.rootfs.agent.file;
    await check(report, 'rootfs-configuration', () => {
      if (manifest.schemaVersion === 2 && !options.rootfsPath) {
        throw markHostPreflightError(new Error('Canonical enclave rootfs path is required for schema version 2'),
          'requirement-not-met');
      }
      if (sharedRootfs) {
        if (
          (options.rootfsPath ?? options.scriptRootfsPath) !== rootfsPaths.script
          || (options.scriptRootfsPath && options.scriptRootfsPath !== rootfsPaths.script)
          || (options.agentRootfsPath && options.agentRootfsPath !== rootfsPaths.agent)
        ) {
          throw markHostPreflightError(
            new Error('Configured enclave rootfs does not match the trusted manifest path (shared)'),
            'requirement-not-met');
        }
      } else if (
        options.rootfsPath
        || options.scriptRootfsPath !== rootfsPaths.script
        || options.agentRootfsPath !== rootfsPaths.agent
      ) {
        throw markHostPreflightError(
          new Error('Configured enclave rootfs does not match the trusted manifest path (split)'),
          'requirement-not-met');
      }
    });
    for (const role of ['script', 'agent'] as const) {
      if (sharedRootfs && role === 'agent') continue;
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
        await copyRootfs(rootfsPath, verifiedRootfs);
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
        verifyAttestation(options.attestationToolPath, verifiedRootfs, verifiedProvenance));
    }
    for (const role of ['script', 'agent'] as const) {
      if (sharedRootfs && role === 'agent'
        && manifest.rootfs.script.sbom.file === manifest.rootfs.agent.sbom.file) {
        rootfs.agent = { path: rootfsPaths.agent, artifact: manifest.rootfs.agent };
        continue;
      }
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
      if (role === 'script') rootfs.script = { path: rootfsPaths.script, artifact };
      else rootfs.agent = { path: rootfsPaths.agent, artifact };
    }
    verified = Object.freeze({
      manifest,
      manifestPath: options.manifestPath,
      manifestBundlePath: options.manifestBundlePath,
      rootfs: Object.freeze(rootfs),
    });
  } catch (error) {
    failure = { error };
  }
  try {
    await fs.rm(verificationDirectory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (failure) throw new HostPreflightCleanupError(failure.error, cleanupError);
    throw cleanupError;
  }
  if (failure) throw failure.error;
  return verified!;
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
