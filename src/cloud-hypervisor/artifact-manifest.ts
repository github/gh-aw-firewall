import {
  CLOUD_HYPERVISOR_RELEASE_VERSION,
  type CloudHypervisorArtifactDigests,
} from '../types/runtime-options';
import { version as AWF_VERSION } from '../../package.json';

const VIRTIOFSD_RELEASE_VERSION = '1.10.0';
export const CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG = `v${AWF_VERSION}`;

export const CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY = 'github/gh-aw-firewall';
export const CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/release.yml';

const ARTIFACT_FILES = {
  cloudHypervisor: 'cloud-hypervisor',
  virtiofsd: 'virtiofsd',
  kernel: 'vmlinux.bin',
  rootfs: 'rootfs.ext4',
  supervisor: 'awf-supervisor',
} as const;

type ArtifactName = keyof typeof ARTIFACT_FILES;

export interface CloudHypervisorArtifactManifest {
  schemaVersion: 1;
  release: {
    repository: typeof CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY;
    workflow: typeof CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW;
    tag: string;
    sourceCommit: string;
  };
  architecture: 'x86_64';
  artifacts: Record<ArtifactName, {
    file: string;
    version: string;
    sha256: string;
  }>;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parseCloudHypervisorArtifactManifest(
  contents: string,
  expectedReleaseTag: string,
): CloudHypervisorArtifactManifest {
  if (expectedReleaseTag !== CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG) {
    throw new Error(
      `Cloud Hypervisor artifacts must match this AWF release: expected ${
        CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG}, got ${expectedReleaseTag}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Cloud Hypervisor artifact manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = requireObject(parsed, 'Cloud Hypervisor artifact manifest');
  if (manifest.schemaVersion !== 1) {
    throw new Error('Cloud Hypervisor artifact manifest schemaVersion must be 1');
  }
  if (manifest.architecture !== 'x86_64') {
    throw new Error('Cloud Hypervisor artifact manifest architecture must be x86_64');
  }
  const release = requireObject(manifest.release, 'manifest.release');
  if (release.repository !== CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY) {
    throw new Error(
      `manifest.release.repository must be ${CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY}`,
    );
  }
  if (release.workflow !== CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW) {
    throw new Error(
      `manifest.release.workflow must be ${CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW}`,
    );
  }
  if (release.tag !== expectedReleaseTag) {
    throw new Error(
      `Cloud Hypervisor artifact manifest release mismatch: expected ${expectedReleaseTag}, got ${
        String(release.tag)
      }`,
    );
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expectedReleaseTag)) {
    throw new Error(`Cloud Hypervisor artifact release tag is invalid: ${expectedReleaseTag}`);
  }
  requireString(release.sourceCommit, 'manifest.release.sourceCommit');
  if (!/^[a-f0-9]{40}$/.test(release.sourceCommit as string)) {
    throw new Error('manifest.release.sourceCommit must be a lowercase 40-character Git SHA');
  }

  const artifacts = requireObject(manifest.artifacts, 'manifest.artifacts');
  const normalized = {} as CloudHypervisorArtifactManifest['artifacts'];
  for (const [name, expectedFile] of Object.entries(ARTIFACT_FILES) as [
    ArtifactName,
    string,
  ][]) {
    const artifact = requireObject(artifacts[name], `manifest.artifacts.${name}`);
    const file = requireString(artifact.file, `manifest.artifacts.${name}.file`);
    const version = requireString(artifact.version, `manifest.artifacts.${name}.version`);
    const sha256 = requireString(artifact.sha256, `manifest.artifacts.${name}.sha256`);
    if (file !== expectedFile) {
      throw new Error(`manifest.artifacts.${name}.file must be ${expectedFile}`);
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`manifest.artifacts.${name}.sha256 must be a lowercase SHA-256 digest`);
    }
    normalized[name] = { file, version, sha256 };
  }
  if (normalized.cloudHypervisor.version !== CLOUD_HYPERVISOR_RELEASE_VERSION) {
    throw new Error(
      `manifest Cloud Hypervisor version must be ${CLOUD_HYPERVISOR_RELEASE_VERSION}`,
    );
  }
  if (normalized.virtiofsd.version !== VIRTIOFSD_RELEASE_VERSION) {
    throw new Error(`manifest virtiofsd version must be ${VIRTIOFSD_RELEASE_VERSION}`);
  }
  if (normalized.supervisor.version !== expectedReleaseTag) {
    throw new Error('manifest supervisor version must match the expected AWF release tag');
  }
  if (normalized.rootfs.version !== expectedReleaseTag) {
    throw new Error('manifest rootfs version must match the expected AWF release tag');
  }

  return {
    schemaVersion: 1,
    release: {
      repository: CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
      workflow: CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
      tag: expectedReleaseTag,
      sourceCommit: release.sourceCommit as string,
    },
    architecture: 'x86_64',
    artifacts: normalized,
  };
}

export function artifactDigestsFromManifest(
  manifest: CloudHypervisorArtifactManifest,
): Required<CloudHypervisorArtifactDigests> {
  return {
    cloudHypervisor: manifest.artifacts.cloudHypervisor.sha256,
    virtiofsd: manifest.artifacts.virtiofsd.sha256,
    kernel: manifest.artifacts.kernel.sha256,
    rootfs: manifest.artifacts.rootfs.sha256,
    supervisor: manifest.artifacts.supervisor.sha256,
  };
}

export function assertArtifactBasenames(
  manifest: CloudHypervisorArtifactManifest,
  paths: Record<ArtifactName, string>,
): void {
  for (const name of Object.keys(ARTIFACT_FILES) as ArtifactName[]) {
    if (paths[name].split('/').pop() !== manifest.artifacts[name].file) {
      throw new Error(
        `Cloud Hypervisor ${name} artifact must be named ${manifest.artifacts[name].file}`,
      );
    }
  }
}
