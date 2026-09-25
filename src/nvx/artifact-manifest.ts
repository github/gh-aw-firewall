import { version as AWF_VERSION } from '../../package.json';

export const NVX_RELEASE_TAG = 'v0.1.0-dev.d561c4300ebe';
export const NVX_COMMIT = 'd561c4300ebe854baba5d154056ead6f9d462047';
export const NVX_OPENVMM_COMMIT = '0bc357bbcf3a654b63dfb51f1103c5751bf3d31f';
export const NVX_ARTIFACT_RELEASE_TAG = `v${AWF_VERSION}`;
export const NVX_ARTIFACT_REPOSITORY = 'github/gh-aw-firewall';
export const NVX_ARTIFACT_SIGNER_WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/release.yml';
export const NVX_VALIDATION_SIGNER_WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/nvx-phase-3b-live-kvm.yml';
export const NVX_SMOKE_SIGNER_WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/smoke-nvx-copilot.lock.yml';
export const NVX_BUILD_TEST_SIGNER_WORKFLOW =
  'github/gh-aw-firewall/.github/workflows/smoke-nvx-build-test.lock.yml';

const ARTIFACT_FILES = {
  openvmm: 'openvmm',
  kernel: 'vmlinux',
  initramfs: 'initramfs.cpio.gz',
} as const;
// Conservative per-role ceilings bound pre-copy disk exposure while leaving
// headroom for expected OpenVMM, kernel, and initramfs artifact growth. The
// pinned OpenVMM binary is 481,508,816 bytes, so its ceiling is the next
// binary-size boundary rather than an unbounded allowance.
const ARTIFACT_SIZE_LIMITS_BYTES = {
  openvmm: 512 * 1024 * 1024,
  kernel: 512 * 1024 * 1024,
  initramfs: 1024 * 1024 * 1024,
} as const;

export type NvxTrustedArtifactName = keyof typeof ARTIFACT_FILES;

export interface NvxArtifactManifest {
  readonly schemaVersion: 2;
  readonly release: {
    readonly repository: typeof NVX_ARTIFACT_REPOSITORY;
    readonly workflow: string;
    readonly tag: string;
    readonly sourceCommit: string;
  };
  readonly upstream: {
    readonly releaseTag: typeof NVX_RELEASE_TAG;
    readonly nvxCommit: typeof NVX_COMMIT;
    readonly openvmmCommit: typeof NVX_OPENVMM_COMMIT;
  };
  readonly architecture: 'x86_64';
  readonly artifacts: Record<NvxTrustedArtifactName, {
    readonly file: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }>;
}

export function parseNvxArtifactManifest(
  contents: string,
  expectedReleaseTag: string,
  expectedSignerWorkflow = NVX_ARTIFACT_SIGNER_WORKFLOW,
): NvxArtifactManifest {
  assertTrustedSignerWorkflow(expectedSignerWorkflow);
  if (expectedReleaseTag !== NVX_ARTIFACT_RELEASE_TAG) {
    throw new Error(
      `NVX artifacts must match this AWF release: expected ` +
      `${NVX_ARTIFACT_RELEASE_TAG}, got ${expectedReleaseTag}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `NVX artifact manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = requireExactObject(value, 'NVX artifact manifest', [
    'schemaVersion',
    'release',
    'upstream',
    'architecture',
    'artifacts',
  ]);
  if (manifest.schemaVersion !== 2) {
    throw new Error('NVX artifact manifest schemaVersion must be 2');
  }
  if (manifest.architecture !== 'x86_64') {
    throw new Error('NVX artifact manifest architecture must be x86_64');
  }

  const release = requireExactObject(manifest.release, 'manifest.release', [
    'repository',
    'workflow',
    'tag',
    'sourceCommit',
  ]);
  if (release.repository !== NVX_ARTIFACT_REPOSITORY) {
    throw new Error(`manifest.release.repository must be ${NVX_ARTIFACT_REPOSITORY}`);
  }
  if (release.workflow !== expectedSignerWorkflow) {
    throw new Error(`manifest.release.workflow must be ${expectedSignerWorkflow}`);
  }
  if (release.tag !== expectedReleaseTag) {
    throw new Error(
      `NVX artifact manifest release mismatch: expected ${expectedReleaseTag}, ` +
      `got ${String(release.tag)}`,
    );
  }
  const sourceCommit = requireSha256OrGitSha(
    release.sourceCommit,
    'manifest.release.sourceCommit',
    40,
  );

  const upstream = requireExactObject(manifest.upstream, 'manifest.upstream', [
    'releaseTag',
    'nvxCommit',
    'openvmmCommit',
  ]);
  if (upstream.releaseTag !== NVX_RELEASE_TAG) {
    throw new Error(`manifest.upstream.releaseTag must be ${NVX_RELEASE_TAG}`);
  }
  if (upstream.nvxCommit !== NVX_COMMIT) {
    throw new Error(`manifest.upstream.nvxCommit must be ${NVX_COMMIT}`);
  }
  if (upstream.openvmmCommit !== NVX_OPENVMM_COMMIT) {
    throw new Error(`manifest.upstream.openvmmCommit must be ${NVX_OPENVMM_COMMIT}`);
  }

  const artifacts = requireExactObject(
    manifest.artifacts,
    'manifest.artifacts',
    Object.keys(ARTIFACT_FILES),
  );
  const normalized = {} as NvxArtifactManifest['artifacts'];
  for (const [name, expectedFile] of Object.entries(ARTIFACT_FILES) as [
    NvxTrustedArtifactName,
    string,
  ][]) {
    const artifact = requireExactObject(
      artifacts[name],
      `manifest.artifacts.${name}`,
      ['file', 'sizeBytes', 'sha256'],
    );
    if (artifact.file !== expectedFile) {
      throw new Error(`manifest.artifacts.${name}.file must be ${expectedFile}`);
    }
    normalized[name] = {
      file: expectedFile,
      sizeBytes: requireArtifactSize(
        artifact.sizeBytes,
        `manifest.artifacts.${name}.sizeBytes`,
        ARTIFACT_SIZE_LIMITS_BYTES[name],
      ),
      sha256: requireSha256OrGitSha(
        artifact.sha256,
        `manifest.artifacts.${name}.sha256`,
        64,
      ),
    };
  }

  return {
    schemaVersion: 2,
    release: {
      repository: NVX_ARTIFACT_REPOSITORY,
      workflow: expectedSignerWorkflow,
      tag: expectedReleaseTag,
      sourceCommit,
    },
    upstream: {
      releaseTag: NVX_RELEASE_TAG,
      nvxCommit: NVX_COMMIT,
      openvmmCommit: NVX_OPENVMM_COMMIT,
    },
    architecture: 'x86_64',
    artifacts: normalized,
  };
}

function assertTrustedSignerWorkflow(workflow: string): void {
  if (
    workflow !== NVX_ARTIFACT_SIGNER_WORKFLOW &&
    workflow !== NVX_VALIDATION_SIGNER_WORKFLOW &&
    workflow !== NVX_SMOKE_SIGNER_WORKFLOW &&
    workflow !== NVX_BUILD_TEST_SIGNER_WORKFLOW
  ) {
    throw new Error(`Untrusted NVX artifact signer workflow: ${workflow}`);
  }
}

export function assertNvxArtifactBasenames(
  manifest: NvxArtifactManifest,
  paths: Record<NvxTrustedArtifactName, string>,
): void {
  for (const name of Object.keys(ARTIFACT_FILES) as NvxTrustedArtifactName[]) {
    if (paths[name].split('/').pop() !== manifest.artifacts[name].file) {
      throw new Error(
        `NVX ${name} artifact must be named ${manifest.artifacts[name].file}`,
      );
    }
  }
}

function requireExactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
  }
  return object;
}

function requireSha256OrGitSha(
  value: unknown,
  label: string,
  length: 40 | 64,
): string {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw new Error(`${label} must be a lowercase ${length}-character digest`);
  }
  return value;
}

function requireArtifactSize(value: unknown, label: string, maxBytes: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maxBytes
  ) {
    throw new Error(`${label} must be a positive integer no larger than ${maxBytes}`);
  }
  return value as number;
}
