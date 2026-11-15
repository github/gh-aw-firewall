import { constants } from 'fs';
import * as path from 'path';
import execa from 'execa';
import type { CloudHypervisorArtifactDigests, CloudHypervisorOptions } from '../types/runtime-options';
import {
  CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
  CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
  artifactDigestsFromManifest,
  assertArtifactBasenames,
  parseCloudHypervisorArtifactManifest,
} from './artifact-manifest';
import type {
  CloudHypervisorArtifactSnapshot, CloudHypervisorCommonArtifactSnapshot,
} from './artifact-snapshot';
import { assertDigest, assertTrustedRegularFile, hasCompleteArtifactDigests } from './artifact-trust';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';
import type { CloudHypervisorHostToolPaths, CloudHypervisorPreflightDependencies } from './preflight';

interface ArtifactConfig extends CloudHypervisorOptions {
  commonOnly: boolean;
}

export function hasPrimaryRootfs(
  snapshot: CloudHypervisorCommonArtifactSnapshot,
): snapshot is CloudHypervisorArtifactSnapshot {
  return 'rootfsPath' in snapshot && typeof snapshot.rootfsPath === 'string';
}

export async function verifyManifestAttestation(
  ghBinaryPath: string,
  manifestPath: string,
  bundlePath: string,
): Promise<void> {
  const result = await execa(ghBinaryPath, [
    'attestation',
    'verify',
    manifestPath,
    '--repo',
    CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
    '--bundle',
    bundlePath,
    '--signer-workflow',
    CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
    '--deny-self-hosted-runners',
  ], {
    reject: false,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.exitCode !== 0) {
    throw markHostPreflightError(new Error(
      `GitHub artifact attestation verification failed with code ${result.exitCode}: ${result.stderr.trim()
      }`,
    ), 'command-failed');
  }
}

export async function checkArtifactBinaryTrust(
  report: HostPreflightReporter,
  dependencies: CloudHypervisorPreflightDependencies,
  config: ArtifactConfig,
): Promise<string> {
  const developmentBypass = config.developmentAllowUnattestedArtifacts === true;
  await report.check('artifact-configuration', () => {
    if (config.commonOnly && developmentBypass) {
      throw new Error('Enclave common artifacts require an attested primary manifest');
    }
    if (!config.kernelPath || (!config.commonOnly && !config.rootfsPath) || !config.supervisorPath) {
      throw new Error(
        'Cloud Hypervisor requires guest kernel, rootfs, and supervisor artifact paths',
      );
    }
    if (
      developmentBypass &&
      process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS !== '1'
    ) {
      throw new Error(
        'Cloud Hypervisor development artifact bypass requires ' +
        'AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1',
      );
    }
    if (
      !developmentBypass &&
      (!config.artifactManifestPath ||
        !config.artifactManifestBundlePath ||
        !config.artifactReleaseTag)
    ) {
      throw new Error(
        'Cloud Hypervisor requires an artifact manifest, attestation bundle, and expected release tag',
      );
    }
  });

  await report.check('cloud-hypervisor-trust', () => assertTrustedRegularFile(
    'Cloud Hypervisor binary',
    config.cloudHypervisorBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  ));
  const virtiofsdBinary = path.join(path.dirname(config.cloudHypervisorBinary), 'virtiofsd');
  await report.check('virtiofsd-trust', () => assertTrustedRegularFile(
    'virtiofsd binary',
    virtiofsdBinary,
    constants.R_OK | constants.X_OK,
    dependencies,
  ));
  return virtiofsdBinary;
}

export async function createPreflightArtifactSnapshot(
  report: HostPreflightReporter,
  dependencies: CloudHypervisorPreflightDependencies,
  config: ArtifactConfig & { virtiofsdBinary: string; tools: CloudHypervisorHostToolPaths },
): Promise<CloudHypervisorCommonArtifactSnapshot> {
  const developmentBypass = config.developmentAllowUnattestedArtifacts === true;
  await report.check('kernel-trust', () => assertTrustedRegularFile(
    'Cloud Hypervisor guest kernel',
    config.kernelPath!,
    constants.R_OK,
    dependencies,
  ));
  if (!config.commonOnly) {
    await report.check('rootfs-trust', () => assertTrustedRegularFile(
      'Cloud Hypervisor rootfs', config.rootfsPath!, constants.R_OK, dependencies,
    ));
  } else {
    report.notRequired('rootfs-trust');
  }
  await report.check('supervisor-trust', () => assertTrustedRegularFile(
    'Cloud Hypervisor guest supervisor',
    config.supervisorPath!,
    constants.R_OK,
    dependencies,
  ));
  let rootfsSbomPath: string | undefined;
  if (!developmentBypass) {
    await report.check('manifest-trust', () => assertTrustedRegularFile(
      'Cloud Hypervisor artifact manifest',
      config.artifactManifestPath!,
      constants.R_OK,
      dependencies,
    ));
    await report.check('bundle-trust', () => assertTrustedRegularFile(
      'Cloud Hypervisor artifact attestation bundle',
      config.artifactManifestBundlePath!,
      constants.R_OK,
      dependencies,
    ));
    if (!config.commonOnly) {
      const candidate = path.join(path.dirname(config.rootfsPath!), 'rootfs.sbom.spdx.json');
      rootfsSbomPath = await report.check('sbom-trust', async () => {
        try {
          await dependencies.lstat(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
        await assertTrustedRegularFile('Cloud Hypervisor rootfs SBOM', candidate, constants.R_OK, dependencies);
        return candidate;
      });
    }
  }
  if (!rootfsSbomPath) report.notRequired('sbom-trust');

  const commonSources = {
    cloudHypervisorBinary: config.cloudHypervisorBinary,
    virtiofsdBinary: config.virtiofsdBinary,
    kernelPath: config.kernelPath!,
    supervisorPath: config.supervisorPath!,
    ...(!developmentBypass
      ? {
        manifestPath: config.artifactManifestPath!,
        bundlePath: config.artifactManifestBundlePath!,
      }
      : {}),
  };
  const copy = (source: string, destination: string) =>
    dependencies.copySparseFile(config.tools.rsync, source, destination);
  return report.check('artifact-snapshot', () => config.commonOnly
    ? dependencies.createCommonArtifactSnapshot(commonSources, copy)
    : dependencies.createArtifactSnapshot({
      ...commonSources, rootfsPath: config.rootfsPath!,
      ...(rootfsSbomPath ? { rootfsSbomPath } : {}),
    }, copy));
}

export async function verifyPreflightArtifactBinaries(
  report: HostPreflightReporter,
  dependencies: CloudHypervisorPreflightDependencies,
  config: ArtifactConfig & { virtiofsdBinary: string; snapshot: CloudHypervisorCommonArtifactSnapshot },
): Promise<Required<CloudHypervisorArtifactDigests>> {
  const { snapshot, commonOnly } = config;
  const developmentBypass = config.developmentAllowUnattestedArtifacts === true;
  if (!commonOnly && !hasPrimaryRootfs(snapshot)) {
    throw new Error('Primary Cloud Hypervisor rootfs snapshot is missing');
  }
  let artifactDigests: Required<CloudHypervisorArtifactDigests>;
  if (developmentBypass) {
    if (!hasCompleteArtifactDigests(config.sha256)) {
      throw new Error(
        'Cloud Hypervisor development artifact bypass requires SHA-256 digests for all five artifacts',
      );
    }
    artifactDigests = config.sha256;
  } else {
    if (!snapshot.manifestPath || !snapshot.bundlePath) {
      throw new Error('Cloud Hypervisor attested artifact snapshot is missing its manifest or bundle');
    }
    const manifestPath = snapshot.manifestPath;
    const bundlePath = snapshot.bundlePath;
    const ghBinaryPath = await report.check('tool-gh', () => dependencies.assertToolAvailable('gh'));
    await report.check('manifest-attestation', () => dependencies.verifyManifestAttestation(
      ghBinaryPath,
      manifestPath,
      bundlePath,
    ));
    const manifest = await report.check('manifest-contents', async () => {
      const parsed = parseCloudHypervisorArtifactManifest(
        await dependencies.readFile(manifestPath),
        config.artifactReleaseTag!,
      );
      const basenames = {
        cloudHypervisor: config.cloudHypervisorBinary,
        virtiofsd: config.virtiofsdBinary,
        kernel: config.kernelPath!,
        supervisor: config.supervisorPath!,
      };
      if (commonOnly) {
        for (const name of ['cloudHypervisor', 'virtiofsd', 'kernel', 'supervisor'] as const) {
          if (path.basename(basenames[name]) !== parsed.artifacts[name].file) {
            throw new Error(`Cloud Hypervisor ${name} artifact basename mismatch`);
          }
        }
      } else {
        assertArtifactBasenames(parsed, { ...basenames, rootfs: config.rootfsPath! });
      }
      return parsed;
    });
    artifactDigests = artifactDigestsFromManifest(manifest);
    if (!commonOnly && manifest.artifacts.rootfs.sbom) {
      if (!hasPrimaryRootfs(snapshot) || !snapshot.rootfsSbomPath) {
        throw new Error('Cloud Hypervisor rootfs SBOM snapshot is missing');
      }
      const sbomPath = snapshot.rootfsSbomPath;
      await report.check('sbom-digest', () => assertDigest(
        'Cloud Hypervisor rootfs SBOM', sbomPath,
        manifest.artifacts.rootfs.sbom!.sha256, dependencies,
      ));
      await report.check('sbom-contents', async () => {
        const document: unknown = JSON.parse(await dependencies.readFile(sbomPath));
        const sbom = document as {
          spdxVersion?: unknown;
          packages?: Array<{ SPDXID?: string; checksums?: Array<{ algorithm?: string; checksumValue?: string }> }>;
          files?: unknown[];
        } | null;
        if (sbom?.spdxVersion !== 'SPDX-2.3'
          || !Array.isArray(sbom.files) || sbom.files.length === 0
          || !Array.isArray(sbom.packages)
          || sbom.packages.filter(pkg => pkg?.SPDXID === 'SPDXRef-Rootfs'
            && Array.isArray(pkg.checksums) && pkg.checksums.some(check => check?.algorithm === 'SHA256'
              && check.checksumValue === artifactDigests.rootfs)).length !== 1) {
          throw new Error('Cloud Hypervisor rootfs SBOM does not bind its final filesystem digest');
        }
      });
    } else {
      report.notRequired('sbom-digest');
      report.notRequired('sbom-contents');
    }
  }
  if (developmentBypass) {
    report.notRequired('sbom-digest');
    report.notRequired('sbom-contents');
  }
  await report.check('cloud-hypervisor-digest', () => assertDigest(
    'Cloud Hypervisor binary',
    snapshot.cloudHypervisorBinary,
    artifactDigests.cloudHypervisor,
    dependencies,
  ));
  await report.check('virtiofsd-digest', () => assertDigest(
    'virtiofsd binary',
    snapshot.virtiofsdBinary,
    artifactDigests.virtiofsd,
    dependencies,
  ));
  return artifactDigests;
}

export async function verifyPreflightGuestDigests(
  report: HostPreflightReporter,
  dependencies: CloudHypervisorPreflightDependencies,
  config: {
    commonOnly: boolean;
    snapshot: CloudHypervisorCommonArtifactSnapshot;
    artifactDigests: Required<CloudHypervisorArtifactDigests>;
  },
): Promise<void> {
  const { snapshot, artifactDigests, commonOnly } = config;
  await report.check('kernel-digest', () => assertDigest(
    'Cloud Hypervisor guest kernel',
    snapshot.kernelPath,
    artifactDigests.kernel,
    dependencies,
  ));
  if (!commonOnly) {
    if (!hasPrimaryRootfs(snapshot)) throw new Error('Primary Cloud Hypervisor rootfs snapshot is missing');
    const rootfsPath = snapshot.rootfsPath;
    await report.check('rootfs-digest', () => assertDigest(
      'Cloud Hypervisor rootfs', rootfsPath, artifactDigests.rootfs, dependencies,
    ));
  } else {
    report.notRequired('rootfs-digest');
  }
  await report.check('supervisor-digest', () => assertDigest(
    'Cloud Hypervisor guest supervisor',
    snapshot.supervisorPath,
    artifactDigests.supervisor,
    dependencies,
  ));
}
