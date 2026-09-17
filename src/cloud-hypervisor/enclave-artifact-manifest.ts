import { version as AWF_VERSION } from '../../package.json';
import { CLOUD_HYPERVISOR_RELEASE_VERSION } from '../types/runtime-options';
import {
  CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
  CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
} from './artifact-manifest';

export type CloudHypervisorEnclaveRole = 'script' | 'agent';
export const CLOUD_HYPERVISOR_ENCLAVE_KERNEL_VERSION = '6.1.141';

const ROLE_METADATA = {
  script: {
    file: 'enclave-script-rootfs.ext4',
    entrypoint: '/usr/local/bin/run-enclave-script',
    sbomFile: 'enclave-script-rootfs.sbom.spdx.json',
  },
  agent: {
    file: 'enclave-agent-rootfs.ext4',
    entrypoint: '/usr/local/bin/run-enclave-agent',
    sbomFile: 'enclave-agent-rootfs.sbom.spdx.json',
  },
} as const;

export interface CloudHypervisorEnclaveRootfsArtifact {
  readonly file: string;
  readonly role: CloudHypervisorEnclaveRole;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly uid: 65534;
  readonly gid: 65534;
  readonly entrypoint: string;
  readonly sourceImage: string;
  readonly sourceImageDigest: string;
  readonly sbom: {
    readonly file: string;
    readonly sha256: string;
  };
}

export interface CloudHypervisorEnclaveArtifactManifest {
  readonly schemaVersion: 1;
  readonly artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set';
  readonly architecture: 'x86_64';
  readonly release: {
    readonly repository: typeof CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY;
    readonly workflow: typeof CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW;
    readonly tag: string;
    readonly sourceCommit: string;
  };
  readonly compatibility: {
    readonly cloudHypervisorVersion: string;
    readonly kernelVersion: string;
    readonly supervisorVersion: string;
  };
  readonly rootfs: Readonly<Record<
    CloudHypervisorEnclaveRole,
    CloudHypervisorEnclaveRootfsArtifact
  >>;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireClosedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} must contain exactly: ${allowed.join(', ')}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function parseRole(
  value: unknown,
  role: CloudHypervisorEnclaveRole,
  expectedReleaseTag: string,
): CloudHypervisorEnclaveRootfsArtifact {
  const label = `manifest.rootfs.${role}`;
  const artifact = requireObject(value, label);
  requireClosedKeys(artifact, [
    'entrypoint',
    'file',
    'gid',
    'role',
    'sbom',
    'sha256',
    'sizeBytes',
    'sourceImage',
    'sourceImageDigest',
    'uid',
    'version',
  ], label);
  const metadata = ROLE_METADATA[role];
  if (artifact.role !== role) throw new Error(`${label}.role must be ${role}`);
  if (artifact.file !== metadata.file) {
    throw new Error(`${label}.file must be ${metadata.file}`);
  }
  if (artifact.entrypoint !== metadata.entrypoint) {
    throw new Error(`${label}.entrypoint must be ${metadata.entrypoint}`);
  }
  if (artifact.version !== expectedReleaseTag) {
    throw new Error(`${label}.version must match the expected AWF release tag`);
  }
  if (artifact.uid !== 65534 || artifact.gid !== 65534) {
    throw new Error(`${label} must use fixed uid/gid 65534`);
  }
  if (
    typeof artifact.sizeBytes !== 'number'
    || !Number.isSafeInteger(artifact.sizeBytes)
    || artifact.sizeBytes <= 0
  ) {
    throw new Error(`${label}.sizeBytes must be a positive safe integer`);
  }
  const sbom = requireObject(artifact.sbom, `${label}.sbom`);
  requireClosedKeys(sbom, ['file', 'sha256'], `${label}.sbom`);
  if (sbom.file !== metadata.sbomFile) {
    throw new Error(`${label}.sbom.file must be ${metadata.sbomFile}`);
  }
  const sourceImage = requireString(artifact.sourceImage, `${label}.sourceImage`);
  const expectedImage = new RegExp(
    `^ghcr\\.io/github/gh-aw-firewall/enclave-${role}@sha256:[a-f0-9]{64}$`,
  );
  if (!expectedImage.test(sourceImage)) {
    throw new Error(`${label}.sourceImage must be the release-pinned ${role} enclave image`);
  }

  return {
    file: metadata.file,
    role,
    version: expectedReleaseTag,
    sha256: requireDigest(artifact.sha256, `${label}.sha256`),
    sizeBytes: artifact.sizeBytes,
    uid: 65534,
    gid: 65534,
    entrypoint: metadata.entrypoint,
    sourceImage,
    sourceImageDigest: requireDigest(
      artifact.sourceImageDigest,
      `${label}.sourceImageDigest`,
    ),
    sbom: {
      file: metadata.sbomFile,
      sha256: requireDigest(sbom.sha256, `${label}.sbom.sha256`),
    },
  };
}

export function parseCloudHypervisorEnclaveArtifactManifest(
  contents: string,
  expectedReleaseTag: string,
): CloudHypervisorEnclaveArtifactManifest {
  const runningReleaseTag = `v${AWF_VERSION}`;
  if (expectedReleaseTag !== runningReleaseTag) {
    throw new Error(
      `Cloud Hypervisor enclave artifacts must match this AWF release: expected ${
        runningReleaseTag}, got ${expectedReleaseTag}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Cloud Hypervisor enclave artifact manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = requireObject(parsed, 'Cloud Hypervisor enclave artifact manifest');
  requireClosedKeys(manifest, [
    'architecture',
    'artifactType',
    'compatibility',
    'release',
    'rootfs',
    'schemaVersion',
  ], 'Cloud Hypervisor enclave artifact manifest');
  if (manifest.schemaVersion !== 1) {
    throw new Error('Cloud Hypervisor enclave artifact manifest schemaVersion must be 1');
  }
  if (manifest.artifactType !== 'awf-cloud-hypervisor-enclave-rootfs-set') {
    throw new Error(
      'Cloud Hypervisor enclave artifact manifest artifactType is not supported',
    );
  }
  if (manifest.architecture !== 'x86_64') {
    throw new Error('Cloud Hypervisor enclave artifact manifest architecture must be x86_64');
  }

  const release = requireObject(manifest.release, 'manifest.release');
  requireClosedKeys(release, [
    'repository',
    'sourceCommit',
    'tag',
    'workflow',
  ], 'manifest.release');
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
      `Cloud Hypervisor enclave artifact manifest release mismatch: expected ${
        expectedReleaseTag}, got ${String(release.tag)}`,
    );
  }
  const sourceCommit = requireString(release.sourceCommit, 'manifest.release.sourceCommit');
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('manifest.release.sourceCommit must be a lowercase 40-character Git SHA');
  }

  const compatibility = requireObject(manifest.compatibility, 'manifest.compatibility');
  requireClosedKeys(compatibility, [
    'cloudHypervisorVersion',
    'kernelVersion',
    'supervisorVersion',
  ], 'manifest.compatibility');
  if (compatibility.cloudHypervisorVersion !== CLOUD_HYPERVISOR_RELEASE_VERSION) {
    throw new Error(
      `manifest compatibility requires Cloud Hypervisor ${
        CLOUD_HYPERVISOR_RELEASE_VERSION}`,
    );
  }
  if (compatibility.kernelVersion !== CLOUD_HYPERVISOR_ENCLAVE_KERNEL_VERSION) {
    throw new Error(
      `manifest compatibility requires kernel ${CLOUD_HYPERVISOR_ENCLAVE_KERNEL_VERSION}`,
    );
  }
  if (compatibility.supervisorVersion !== expectedReleaseTag) {
    throw new Error(
      'manifest.compatibility.supervisorVersion must match the expected AWF release tag',
    );
  }

  const rootfs = requireObject(manifest.rootfs, 'manifest.rootfs');
  requireClosedKeys(rootfs, ['agent', 'script'], 'manifest.rootfs');
  return {
    schemaVersion: 1,
    artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
    architecture: 'x86_64',
    release: {
      repository: CLOUD_HYPERVISOR_ARTIFACT_REPOSITORY,
      workflow: CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW,
      tag: expectedReleaseTag,
      sourceCommit,
    },
    compatibility: {
      cloudHypervisorVersion: CLOUD_HYPERVISOR_RELEASE_VERSION,
      kernelVersion: CLOUD_HYPERVISOR_ENCLAVE_KERNEL_VERSION,
      supervisorVersion: expectedReleaseTag,
    },
    rootfs: {
      script: parseRole(rootfs.script, 'script', expectedReleaseTag),
      agent: parseRole(rootfs.agent, 'agent', expectedReleaseTag),
    },
  };
}

export function enclaveRootfsArtifactForRole(
  manifest: CloudHypervisorEnclaveArtifactManifest,
  role: CloudHypervisorEnclaveRole,
): CloudHypervisorEnclaveRootfsArtifact {
  return manifest.rootfs[role];
}
