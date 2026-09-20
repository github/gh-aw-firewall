import {
  NVX_GUEST_ARTIFACT_ROOT,
  NVX_GUEST_RUN_ROOT,
  assertNvxRunLayout,
  createNvxRunLayout,
  toNvxGuestArtifactPath,
  toNvxGuestRunPath,
} from './run-layout';

const RUN_ID = 'a'.repeat(32);

describe('NVX run layout', () => {
  it('derives every privileged resource name from one run ID', () => {
    expect(createNvxRunLayout(RUN_ID)).toEqual({
      runId: RUN_ID,
      artifactSnapshotDirectory: `/run/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
      runDirectory: `/run/awf-nvx/runs/${RUN_ID}`,
      cleanupRecordPath: `/run/awf-nvx/cleanup/${RUN_ID}.json`,
      cgroupPath: `/sys/fs/cgroup/awf-nvx/${RUN_ID}`,
      networkNamespace: `awfnvx-${RUN_ID}`,
    });
  });

  it('rejects malformed IDs and independently altered paths', () => {
    expect(() => createNvxRunLayout('../escape')).toThrow(/run ID/);
    expect(() => assertNvxRunLayout({
      ...createNvxRunLayout(RUN_ID),
      cgroupPath: '/sys/fs/cgroup/other',
    })).toThrow(/cgroupPath/);
  });

  it('translates only paths contained by the canonical bind roots', () => {
    const layout = createNvxRunLayout(RUN_ID);
    expect(toNvxGuestArtifactPath(
      layout,
      `${layout.artifactSnapshotDirectory}/nvx.py`,
    )).toBe(`${NVX_GUEST_ARTIFACT_ROOT}/nvx.py`);
    expect(toNvxGuestRunPath(
      layout,
      `${layout.runDirectory}/scratch.ext4`,
    )).toBe(`${NVX_GUEST_RUN_ROOT}/scratch.ext4`);
    expect(() => toNvxGuestRunPath(layout, '/etc/shadow')).toThrow(/escapes/);
  });
});
