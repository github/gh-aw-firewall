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
    schemaVersion: 2,
    runId: RUN_ID,
    owner: {
      pid: 100,
      startTimeTicks: '1234',
      executable: '/usr/local/bin/awf',
      executableDevice: '8',
      executableInode: '9',
      uid: 0,
      gid: 0,
      networkNamespace: 'net:[4026531840]',
    },
    vmmIdentity: {
      state: 'live',
      name: `awfnvx-${'b'.repeat(20)}`,
      uid: 1000,
      gid: 1001,
    },
    network: {
      resourceToken: '123456789abc',
      namespaceName: `awfnvx-${RUN_ID}`,
      netnsPath: `/var/run/netns/awfnvx-${RUN_ID}`,
      hostVethName: 'vmh123456789abc',
      namespaceVethName: 'vmn123456789abc',
      tapName: 'vmt123456789abc',
      infrastructureBridge: 'awfbr0',
      hostForwardRuleComment: 'awf-microvm-123456789abc',
    },
    resources: {
      artifactSnapshot: {
        path: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}`,
        device: '8',
        inode: '10',
      },
      runDirectory: {
        path: `/run/awf-nvx/runs/${RUN_ID}`,
        device: '8',
        inode: '11',
      },
      networkNamespace: {
        path: `/var/run/netns/awfnvx-${RUN_ID}`,
        device: '8',
        inode: '4026533000',
      },
      networkReservation: {
        path: '/run/awf-microvm-network/reservations/123456789abc.json',
        device: '8',
        inode: '13',
      },
      mountNamespaceInode: '4026533001',
      cgroup: {
        path: `/sys/fs/cgroup/awf-nvx/${RUN_ID}`,
        device: '0',
        inode: '12',
      },
      deviceAcls: [
        { path: '/dev/kvm', device: '5', inode: '1', uid: 1000, permissions: 'rw-' },
        { path: '/dev/net/tun', device: '5', inode: '2', uid: 1000, permissions: 'rw-' },
      ],
      launcher: {
        pid: 200,
        startTimeTicks: '2234',
        executable: '/usr/bin/python3',
        executableDevice: '8',
        executableInode: '20',
        uid: 1000,
        gid: 1001,
        networkNamespace: 'net:[4026533000]',
      },
      openvmm: {
        pid: 201,
        startTimeTicks: '2235',
        executable: `/var/lib/awf-nvx/trusted-artifacts/run-${RUN_ID}/openvmm`,
        executableDevice: '8',
        executableInode: '21',
        uid: 1000,
        gid: 1001,
        networkNamespace: 'net:[4026533000]',
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
    updatedAt: '2026-09-21T00:00:00.000Z',
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
    unsafe.resources.deviceAcls = [
      { path: '/dev/kvm', device: '5', inode: '1', uid: 1000, permissions: 'rw-' },
      { path: '/dev/sda', device: '5', inode: '2', uid: 1000, permissions: 'rw-' },
    ] as typeof unsafe.resources.deviceAcls;
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(unsafe),
      RECORD_PATH,
    )).toThrow(/unsupported path/);

    const duplicate = record();
    duplicate.resources.deviceAcls = [
      { path: '/dev/kvm', device: '5', inode: '1', uid: 1000, permissions: 'rw-' },
      { path: '/dev/kvm', device: '5', inode: '1', uid: 1000, permissions: 'rw-' },
    ];
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(duplicate),
      RECORD_PATH,
    )).toThrow(/duplicate path/);

    const wrongPermissions = record();
    wrongPermissions.resources.deviceAcls[0].permissions = 'r--' as 'rw-';
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(wrongPermissions),
      RECORD_PATH,
    )).toThrow(/permissions/);

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

  it('rejects cleanup paths outside the AWF-owned per-run roots', () => {
    const unsafe = record();
    unsafe.resources.artifactSnapshot.path = '/';
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(unsafe),
      RECORD_PATH,
    )).toThrow(/artifactSnapshot\.path/);

    const unrelated = record();
    unrelated.resources.cgroup.path = `/sys/fs/cgroup/awf-nvx/${'c'.repeat(32)}`;
    expect(() => parseNvxCleanupRecord(
      JSON.stringify(unrelated),
      RECORD_PATH,
    )).toThrow(/cgroup\.path/);
  });
});
