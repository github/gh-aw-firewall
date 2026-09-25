import {
  verifyCloudHypervisorConfinement,
  type CloudHypervisorConfinementVerifierDependencies,
} from './confinement-verifier';
import type { CloudHypervisorLaunchConfinementPolicy } from './launcher';

const PID = 4242;
const CGROUP = '/sys/fs/cgroup/awf-cloud-hypervisor/run-1';
const CAPABILITY_MASK = '0000000000002000';

function launchPolicy(): CloudHypervisorLaunchConfinementPolicy {
  return {
    supplementaryGroups: [978],
    capabilities: {
      inheritable: CAPABILITY_MASK,
      permitted: CAPABILITY_MASK,
      effective: CAPABILITY_MASK,
      bounding: CAPABILITY_MASK,
      ambient: CAPABILITY_MASK,
    },
    noNewPrivs: 1,
  };
}

function status(name: string, seccomp: number, taskId = PID, groups = '978'): string {
  return [
    `Name:\t${name}`,
    `Pid:\t${taskId}`,
    `Tgid:\t${PID}`,
    'Uid:\t1000\t1000\t1000\t1000',
    'Gid:\t1001\t1001\t1001\t1001',
    `Groups:\t${groups}`,
    `CapInh:\t${CAPABILITY_MASK}`,
    `CapPrm:\t${CAPABILITY_MASK}`,
    `CapEff:\t${CAPABILITY_MASK}`,
    `CapBnd:\t${CAPABILITY_MASK}`,
    `CapAmb:\t${CAPABILITY_MASK}`,
    'NoNewPrivs:\t1',
    `Seccomp:\t${seccomp}`,
    '',
  ].join('\n');
}

function procStat(startTime: string): string {
  return `${PID} (cloud hypervisor) ${['S', ...Array(18).fill('0'), startTime, '0'].join(' ')}`;
}

function dependencies(overrides: {
  statReads?: string[];
  executable?: string;
  workerStatus?: string;
  cgroupProcs?: string;
  groups?: string;
  taskListings?: string[][];
  extraFiles?: Record<string, string>;
  taskStartTime?: (taskId: number, read: number) => string;
  vanishedTasks?: readonly number[];
} = {}): CloudHypervisorConfinementVerifierDependencies {
  const taskListings = [...(overrides.taskListings ?? [])];
  const taskStatReads = new Map<number, number>();
  const statReads = [...(overrides.statReads ?? [procStat('98765'), procStat('98765')])];
  const files: Record<string, string> = {
    [`/proc/${PID}/task/${PID}/status`]: status('cloud-hypervis', 0, PID, overrides.groups),
    [`/proc/${PID}/task/${PID + 1}/status`]:
      overrides.workerStatus ?? status('vmm', 2, PID + 1, overrides.groups),
    [`/proc/${PID}/task/${PID + 2}/status`]: status('http-server', 2, PID + 2, overrides.groups),
    [`/proc/${PID}/cgroup`]: '0::/awf-cloud-hypervisor/run-1\n',
    [`${CGROUP}/cgroup.procs`]: overrides.cgroupProcs ?? `${PID}\n`,
    [`${CGROUP}/memory.max`]: '805306368\n',
    [`${CGROUP}/cpu.max`]: '300000 100000\n',
    [`${CGROUP}/pids.max`]: '256\n',
    ...overrides.extraFiles,
  };
  return {
    readFile: jest.fn(async (filePath) => {
      if (filePath === `/proc/${PID}/stat`) {
        const value = statReads.shift();
        if (!value) throw new Error('unexpected stat read');
        return value;
      }
      const taskMatch = filePath.match(new RegExp(`^/proc/${PID}/task/(\\d+)/`));
      if (taskMatch && overrides.vanishedTasks?.includes(Number(taskMatch[1]))) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
      }
      const taskStatMatch = filePath.match(new RegExp(`^/proc/${PID}/task/(\\d+)/stat$`));
      if (taskStatMatch) {
        const taskId = Number(taskStatMatch[1]);
        const read = (taskStatReads.get(taskId) ?? 0) + 1;
        taskStatReads.set(taskId, read);
        return procStat(overrides.taskStartTime?.(taskId, read) ?? String(99000 + taskId));
      }
      const value = files[filePath];
      if (value === undefined) throw new Error(`unexpected read: ${filePath}`);
      return value;
    }),
    readlink: jest.fn(async (filePath) => {
      if (filePath === `/proc/${PID}/exe`) {
        return overrides.executable ?? '/opt/cloud-hypervisor';
      }
      if (filePath === `/proc/${PID}/ns/net`) {
        return 'net:[4026533000]';
      }
      throw new Error(`unexpected readlink: ${filePath}`);
    }),
    readdir: jest.fn(async () => (
      taskListings.shift() ?? [String(PID + 2), String(PID + 1), String(PID)]
    )),
    realpath: jest.fn().mockResolvedValue('/opt/cloud-hypervisor'),
    stat: jest.fn().mockResolvedValue({ ino: 4026533000n }),
  };
}

function options() {
  return {
    pid: PID,
    expectedExecutable: '/opt/cloud-hypervisor',
    identity: { uid: 1000, gid: 1001 },
    launchPolicy: launchPolicy(),
    networkNamespace: 'awfvm-test',
    cgroupPath: CGROUP,
    cgroupLimits: {
      memoryMax: '805306368',
      cpuMax: '300000 100000',
      pidsMax: '256',
    },
  };
}

describe('verifyCloudHypervisorConfinement', () => {
  it('verifies stable process, thread, namespace, and cgroup state with policy-derived capabilities', async () => {
    const result = await verifyCloudHypervisorConfinement(options(), dependencies());

    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 1,
      process: {
        pid: PID,
        startTimeTicks: '98765',
        executable: '/opt/cloud-hypervisor',
      },
      identity: {
        uid: 1000,
        gid: 1001,
        supplementaryGroups: [978],
      },
      capabilities: expect.objectContaining({ effective: CAPABILITY_MASK }),
      noNewPrivs: 1,
      seccomp: {
        mode: 2,
        relevantThreadIds: [PID + 1, PID + 2],
        observedThreadCount: 3,
      },
      networkNamespace: {
        name: 'awfvm-test',
        inode: 'net:[4026533000]',
      },
      cgroup: expect.objectContaining({
        path: CGROUP,
        membership: '/awf-cloud-hypervisor/run-1',
      }),
    }));
  });

  it('accepts an empty Groups field when no supplementary groups are expected', async () => {
    const verificationOptions = options();
    verificationOptions.launchPolicy = {
      ...verificationOptions.launchPolicy,
      supplementaryGroups: [],
    };

    const result = await verifyCloudHypervisorConfinement(
      verificationOptions,
      dependencies({ groups: '' }),
    );

    expect(result.identity.supplementaryGroups).toEqual([]);
  });

  it('fails closed when PID identity changes while evidence is collected', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ statReads: [procStat('98765'), procStat('98766')] }),
    )).rejects.toThrow(/process identity race: PID 4242 start time changed from 98765 to 98766/);
  });

  it('fails closed when the executable changes while evidence is collected', async () => {
    const deps = dependencies();
    (deps.readlink as jest.Mock)
      .mockResolvedValueOnce('/opt/cloud-hypervisor')
      .mockResolvedValueOnce('net:[4026533000]')
      .mockResolvedValueOnce('/usr/bin/python3');
    await expect(verifyCloudHypervisorConfinement(options(), deps))
      .rejects.toThrow(/process identity race: executable changed/);
  });

  describe('benign thread churn', () => {
    const base = [String(PID), String(PID + 1), String(PID + 2)];

    it('accepts and verifies a worker thread created between samples', async () => {
      const result = await verifyCloudHypervisorConfinement(options(), dependencies({
        taskListings: [base, [...base, String(PID + 3)]],
        extraFiles: {
          [`/proc/${PID}/task/${PID + 3}/status`]: status('virtio-blk', 0, PID + 3),
        },
      }));
      expect(result.seccomp.observedThreadCount).toBe(4);
    });

    it('rejects a new thread that does not satisfy the confinement policy', async () => {
      await expect(verifyCloudHypervisorConfinement(options(), dependencies({
        taskListings: [base, [...base, String(PID + 3)]],
        extraFiles: {
          [`/proc/${PID}/task/${PID + 3}/status`]:
            status('virtio-blk', 0, PID + 3).replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'),
        },
      }))).rejects.toThrow(/thread 4245 does not have NoNewPrivs/);
    });

    it('accepts a worker thread exiting between samples or between readdir and read', async () => {
      const result = await verifyCloudHypervisorConfinement(options(), dependencies({
        taskListings: [[...base, String(PID + 3)], base],
        vanishedTasks: [PID + 3],
      }));
      expect(result.seccomp.observedThreadCount).toBe(3);
    });

    it('re-verifies a recycled thread ID instead of trusting the earlier sample', async () => {
      const deps = dependencies({
        taskStartTime: (taskId, read) => (taskId === PID + 2 && read > 1 ? '12345' : String(99000 + taskId)),
      });
      await expect(verifyCloudHypervisorConfinement(options(), deps)).resolves.toEqual(
        expect.objectContaining({
          seccomp: expect.objectContaining({ relevantThreadIds: [PID + 1, PID + 2] }),
        }),
      );
      const statusReads = (deps.readFile as jest.Mock).mock.calls
        .filter(([filePath]) => filePath === `/proc/${PID}/task/${PID + 2}/status`);
      expect(statusReads).toHaveLength(2);
    });

    it('still fails when the main thread disappears', async () => {
      await expect(verifyCloudHypervisorConfinement(options(), dependencies({
        vanishedTasks: [PID],
      }))).rejects.toThrow(/ENOENT/);
    });

    it('enforces the thread bound on the final sample', async () => {
      const many = Array.from({ length: 257 }, (_, index) => String(PID + index));
      await expect(verifyCloudHypervisorConfinement(options(), dependencies({
        taskListings: [base, many],
      }))).rejects.toThrow(/257 threads, exceeding the 256 thread evidence bound/);
    });
  });

  it('rejects a different executable even when the PID exists', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ executable: '/usr/bin/setpriv' }),
    )).rejects.toThrow(/found executable/);
  });

  it('requires the Cloud Hypervisor vmm worker to have seccomp filter mode 2', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ workerStatus: status('vmm', 0, PID + 1) }),
    )).rejects.toThrow(/does not have seccomp filter mode 2/);
  });

  it('requires exclusive membership in the configured bounded cgroup', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ cgroupProcs: `${PID}\n5000\n` }),
    )).rejects.toThrow(/cgroup\.procs to contain only PID/);
  });
});
