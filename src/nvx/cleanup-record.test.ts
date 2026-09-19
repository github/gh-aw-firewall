import * as path from 'path';
import {
  NVX_CLEANUP_ROOT,
  assertNvxCleanupStageConsistency,
  parseNvxCleanupRecord,
} from './cleanup-record';

const RUN_ID = 'a'.repeat(32);
const RECORD_PATH = path.join(NVX_CLEANUP_ROOT, `${RUN_ID}.json`);

function record() {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    owner: {
      pid: 100,
      startTimeTicks: '1234',
      executable: '/usr/local/bin/awf',
    },
    vmmIdentity: {
      name: `awfnvx-${'b'.repeat(20)}`,
      uid: 1000,
      gid: 1001,
    },
    resources: {
      artifactSnapshot: {
        path: '/run/awf-nvx/artifacts/run-1',
        device: '8',
        inode: '10',
      },
      runDirectory: {
        path: '/run/awf-nvx/runs/run-1',
        device: '8',
        inode: '11',
      },
      networkNamespace: {
        name: 'awfnvx-run-1',
        inode: '4026533000',
      },
      mountNamespaceInode: '4026533001',
      cgroup: {
        path: '/sys/fs/cgroup/awf-nvx/run-1',
        device: '0',
        inode: '12',
      },
      deviceAcls: ['/dev/kvm', '/dev/net/tun'],
      launcher: {
        pid: 200,
        startTimeTicks: '2234',
        executable: '/usr/bin/python3',
      },
      openvmm: {
        pid: 201,
        startTimeTicks: '2235',
        executable: '/run/awf-nvx/artifacts/run-1/openvmm',
      },
    },
    stages: {
      accountCreated: true,
      artifactSnapshotCreated: true,
      cgroupCreated: true,
      deviceAclsGranted: true,
      networkCreated: true,
      processStarted: true,
      runDirectoryCreated: true,
    },
  };
}

describe('NVX cleanup record', () => {
  it('parses complete ownership evidence and validates stage consistency', () => {
    const parsed = parseNvxCleanupRecord(JSON.stringify(record()), RECORD_PATH);
    expect(() => assertNvxCleanupStageConsistency(parsed)).not.toThrow();
    expect(parsed.resources.openvmm?.pid).toBe(201);
  });

  it('binds the run ID to the cleanup registry filename', () => {
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(record()),
      path.join(NVX_CLEANUP_ROOT, `${'c'.repeat(32)}.json`),
    )).toThrow(/record path/);
  });

  it('rejects unsupported ACLs and unexpected keys', () => {
    const unsafe = record();
    unsafe.resources.deviceAcls = ['/dev/kvm', '/dev/sda'];
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(unsafe),
      RECORD_PATH,
    )).toThrow(/unsupported or duplicate/);

    const extra = {
      ...record(),
      resources: {
        ...record().resources,
        wildcardCleanup: true,
      },
    };
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(extra),
      RECORD_PATH,
    )).toThrow(/unexpected key set/);
  });

  it('rejects stage flags without committed resource identities', () => {
    const incomplete = record();
    delete (incomplete.resources as Partial<typeof incomplete.resources>).cgroup;
    const parsed = parseNvxCleanupRecord(JSON.stringify(incomplete), RECORD_PATH);
    expect(() => assertNvxCleanupStageConsistency(parsed))
      .toThrow(/cgroup stage and identity are inconsistent/);
  });

  it('requires an exact per-run VMM account identity', () => {
    const unsafe = record();
    unsafe.vmmIdentity.name = 'runner';
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(unsafe),
      RECORD_PATH,
    )).toThrow(/vmmIdentity\.name/);
  });
});
