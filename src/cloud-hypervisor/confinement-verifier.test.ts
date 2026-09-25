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
  finalExecutable?: string;
  initialTaskIds?: number[];
  finalTaskIds?: number[];
  finalTaskStartTime?: string;
  workerStatus?: string;
  newWorkerStatus?: string;
  cgroupProcs?: string;
  groups?: string;
  enoentFinalTaskStatIds?: number[];
  enoentFinalTaskStatusIds?: number[];
} = {}): CloudHypervisorConfinementVerifierDependencies {
  const statReads = [...(overrides.statReads ?? [procStat('98765'), procStat('98765')])];
  let executableReads = 0;
  const taskStatReads = new Map<string, number>();
  const enoentFinalTaskStatIds = new Set(overrides.enoentFinalTaskStatIds ?? []);
  const enoentFinalTaskStatusIds = new Set(overrides.enoentFinalTaskStatusIds ?? []);
  const files: Record<string, string> = {
    [`/proc/${PID}/task/${PID}/status`]: status('cloud-hypervis', 0, PID, overrides.groups),
    [`/proc/${PID}/task/${PID + 1}/status`]:
      overrides.workerStatus ?? status('vmm', 2, PID + 1, overrides.groups),
    [`/proc/${PID}/task/${PID + 2}/status`]: status('http-server', 2, PID + 2, overrides.groups),
    [`/proc/${PID}/task/${PID + 3}/status`]:
      overrides.newWorkerStatus ?? status('worker', 2, PID + 3, overrides.groups),
    [`/proc/${PID}/cgroup`]: '0::/awf-cloud-hypervisor/run-1\n',
    [`${CGROUP}/cgroup.procs`]: overrides.cgroupProcs ?? `${PID}\n`,
    [`${CGROUP}/memory.max`]: '805306368\n',
    [`${CGROUP}/cpu.max`]: '300000 100000\n',
    [`${CGROUP}/pids.max`]: '256\n',
  };
  return {
    readFile: jest.fn(async (filePath) => {
      if (filePath === `/proc/${PID}/stat`) {
        const value = statReads.shift();
        if (!value) throw new Error('unexpected stat read');
        return value;
      }
      const taskStatusMatch = filePath.match(new RegExp(`^/proc/${PID}/task/(\\d+)/status$`));
      if (taskStatusMatch && enoentFinalTaskStatusIds.has(Number(taskStatusMatch[1]))) {
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
      }
      const taskStatMatch = filePath.match(new RegExp(`^/proc/${PID}/task/(\\d+)/stat$`));
      if (taskStatMatch) {
        const reads = (taskStatReads.get(filePath) ?? 0) + 1;
        taskStatReads.set(filePath, reads);
        if (reads === 2 && enoentFinalTaskStatIds.has(Number(taskStatMatch[1]))) {
          throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
        }
        return procStat(
          reads === 1 ? String(99000 + Number(taskStatMatch[1]))
            : overrides.finalTaskStartTime ?? String(99000 + Number(taskStatMatch[1])),
        );
      }
      const value = files[filePath];
      if (value === undefined) throw new Error(`unexpected read: ${filePath}`);
      return value;
    }),
    readlink: jest.fn(async (filePath) => {
      if (filePath === `/proc/${PID}/exe`) {
        executableReads += 1;
        return executableReads === 1
          ? overrides.executable ?? '/opt/cloud-hypervisor'
          : overrides.finalExecutable ?? overrides.executable ?? '/opt/cloud-hypervisor';
      }
      if (filePath === `/proc/${PID}/ns/net`) {
        return 'net:[4026533000]';
      }
      throw new Error(`unexpected readlink: ${filePath}`);
    }),
    readdir: jest.fn()
      .mockResolvedValueOnce((overrides.initialTaskIds ?? [PID, PID + 1, PID + 2]).map(String))
      .mockResolvedValueOnce((overrides.finalTaskIds ?? [PID, PID + 1, PID + 2]).map(String))
      .mockRejectedValue(new Error('unexpected task readdir')),
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
    )).rejects.toThrow(/start time.*98766.*98765/);
  });

  it('accepts worker thread additions and departures between snapshots', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ finalTaskIds: [PID, PID + 1, PID + 2, PID + 3] }),
    )).resolves.toHaveProperty('seccomp.observedThreadCount', 3);
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ initialTaskIds: [PID, PID + 1, PID + 2, PID + 3],
        finalTaskIds: [PID, PID + 1, PID + 2] }),
    )).resolves.toHaveProperty('seccomp.observedThreadCount', 4);
  });

  it('tolerates a surviving thread exiting before its final stat read', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ enoentFinalTaskStatIds: [PID + 2] }),
    )).resolves.toHaveProperty('seccomp.observedThreadCount', 3);
  });

  it('tolerates a newly observed thread exiting before its status read', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({
        finalTaskIds: [PID, PID + 1, PID + 2, PID + 3],
        enoentFinalTaskStatusIds: [PID + 3],
      }),
    )).resolves.toHaveProperty('seccomp.observedThreadCount', 3);
  });


  it('rejects surviving TID recycling with observed and expected start times', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ finalTaskStartTime: '12345' }),
    )).rejects.toThrow(/thread 4242 start time.*12345.*103242/);
  });

  it('rejects a newly appeared thread without no_new_privs', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({
        finalTaskIds: [PID, PID + 1, PID + 2, PID + 3],
        newWorkerStatus: status('worker', 2, PID + 3).replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'),
      }),
    )).rejects.toThrow(/thread 4245.*NoNewPrivs/);
  });

  it('identifies an executable change between snapshots', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ finalExecutable: '/usr/bin/setpriv' }),
    )).rejects.toThrow(/executable.*setpriv.*cloud-hypervisor/);
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
