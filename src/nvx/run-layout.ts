import * as path from 'path';
import {
  NVX_CGROUP_ROOT,
  NVX_CLEANUP_ROOT,
  NVX_RUN_DIRECTORY_ROOT,
  NVX_TRUSTED_ARTIFACT_ROOT,
} from './paths';

export const NVX_GUEST_ARTIFACT_ROOT = '/opt/awf-nvx';
export const NVX_GUEST_RUN_ROOT = '/run/awf-nvx';

export interface NvxRunLayout {
  readonly runId: string;
  readonly artifactSnapshotDirectory: string;
  readonly runDirectory: string;
  readonly cleanupRecordPath: string;
  readonly cgroupPath: string;
  readonly networkNamespace: string;
}

export function createNvxRunLayout(runId: string): NvxRunLayout {
  assertNvxRunId(runId);
  return {
    runId,
    artifactSnapshotDirectory: path.join(NVX_TRUSTED_ARTIFACT_ROOT, `run-${runId}`),
    runDirectory: path.join(NVX_RUN_DIRECTORY_ROOT, runId),
    cleanupRecordPath: path.join(NVX_CLEANUP_ROOT, `${runId}.json`),
    cgroupPath: path.join(NVX_CGROUP_ROOT, runId),
    networkNamespace: `awfnvx-${runId.slice(0, 20)}`,
  };
}

export function assertNvxRunLayout(layout: NvxRunLayout): void {
  const expected = createNvxRunLayout(layout.runId);
  for (const key of [
    'artifactSnapshotDirectory',
    'runDirectory',
    'cleanupRecordPath',
    'cgroupPath',
    'networkNamespace',
  ] as const) {
    if (layout[key] !== expected[key]) {
      throw new Error(`NVX run layout ${key} must be ${expected[key]}`);
    }
  }
}

export function toNvxGuestArtifactPath(
  layout: NvxRunLayout,
  hostPath: string,
): string {
  assertNvxRunLayout(layout);
  return translatePath(
    layout.artifactSnapshotDirectory,
    NVX_GUEST_ARTIFACT_ROOT,
    hostPath,
    'artifact',
  );
}

export function toNvxGuestRunPath(
  layout: NvxRunLayout,
  hostPath: string,
): string {
  assertNvxRunLayout(layout);
  return translatePath(layout.runDirectory, NVX_GUEST_RUN_ROOT, hostPath, 'run');
}

export function assertNvxRunId(runId: string): void {
  if (!/^[a-f0-9]{32}$/.test(runId)) {
    throw new Error('NVX run ID must be 32 lowercase hexadecimal characters');
  }
}

function translatePath(
  hostRoot: string,
  guestRoot: string,
  hostPath: string,
  label: string,
): string {
  const relative = path.relative(hostRoot, path.resolve(hostPath));
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`NVX ${label} path escapes its run layout: ${hostPath}`);
  }
  return relative ? path.posix.join(guestRoot, ...relative.split(path.sep)) : guestRoot;
}
