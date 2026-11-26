import { promises as fs } from 'fs';
import {
  createEnclaveArtifactVerificationDirectory,
  readTrustedArtifactBytes,
  verifyEnclaveArtifactAttestation,
  verifyEnclaveRootfsArtifacts,
  writeEnclaveArtifactVerificationFiles,
} from './enclave-artifact-attestation';
import {
  checkEnclaveArtifact as check,
  checkEnclaveArtifactTrust,
} from './enclave-artifact-trust-checks';
import {
  assertEnclaveRootfsConfiguration,
  enclaveArtifactRootfsPaths,
  parseEnclaveArtifactManifestBytes,
} from './enclave-artifact-manifest';
import type {
  CloudHypervisorEnclaveArtifactPreflightOptions,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './enclave-executor-types';
import {
  HostPreflightCleanupError, HostPreflightReporter,
} from './host-preflight-progress';

export { resolveTrustedAttestationTool } from './enclave-artifact-trust-checks';

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
  const { uid, manifestDir } = await checkEnclaveArtifactTrust(options, report);
  const manifestBytes = await check(report, 'manifest-read', () =>
    readTrustedArtifactBytes(options.manifestPath, uid, 1024 * 1024));
  const bundleBytes = await check(report, 'bundle-read', () =>
    readTrustedArtifactBytes(options.manifestBundlePath, uid, 8 * 1024 * 1024));
  const verificationDirectory = await check(report, 'verification-directory', () =>
    createEnclaveArtifactVerificationDirectory(verificationDirectoryRoot));
  let failure: { error: unknown } | undefined;
  let verified: VerifiedCloudHypervisorEnclaveArtifacts | undefined;
  const roleReports = {
    script: report?.fork('bounded-artifacts', { phase: 'preflight', profile: 'script' }),
    agent: report?.fork('bounded-artifacts', { phase: 'preflight', profile: 'agent' }),
  };
  try {
    const staged = await writeEnclaveArtifactVerificationFiles(verificationDirectory, manifestBytes, bundleBytes);
    const manifest = await check(report, 'manifest-parse', () =>
      parseEnclaveArtifactManifestBytes(manifestBytes, options.releaseTag));
    await check(report, 'manifest-attestation', () =>
      verifyEnclaveArtifactAttestation(options.attestationToolPath, staged.manifestPath, staged.bundlePath));
    const rootfsPaths = enclaveArtifactRootfsPaths(manifestDir, manifest);
    await check(report, 'rootfs-configuration', () =>
      assertEnclaveRootfsConfiguration(options, manifest, rootfsPaths));
    const rootfs = await verifyEnclaveRootfsArtifacts({
      uid, manifestDir, manifest, rootfsPaths, verificationDirectory,
      attestationToolPath: options.attestationToolPath, copyRootfs, roleReports,
    });
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
