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

function status(name: string, seccomp: number, taskId = PID): string {
  return [
    `Name:\t${name}`,
    `Pid:\t${taskId}`,
    `Tgid:\t${PID}`,
    'Uid:\t1000\t1000\t1000\t1000',
    'Gid:\t1001\t1001\t1001\t1001',
    'Groups:\t978',
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
} = {}): CloudHypervisorConfinementVerifierDependencies {
  const statReads = [...(overrides.statReads ?? [procStat('98765'), procStat('98765')])];
  const files: Record<string, string> = {
    [`/proc/${PID}/task/${PID}/status`]: status('cloud-hypervis', 0),
    [`/proc/${PID}/task/${PID + 1}/status`]:
      overrides.workerStatus ?? status('vmm', 2, PID + 1),
    [`/proc/${PID}/task/${PID + 2}/status`]: status('http-server', 2, PID + 2),
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
      const taskStatMatch = filePath.match(new RegExp(`^/proc/${PID}/task/(\\d+)/stat$`));
      if (taskStatMatch) return procStat(String(99000 + Number(taskStatMatch[1])));
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
    readdir: jest.fn().mockResolvedValue([String(PID + 2), String(PID + 1), String(PID)]),
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

  it('fails closed when PID identity changes while evidence is collected', async () => {
    await expect(verifyCloudHypervisorConfinement(
      options(),
      dependencies({ statReads: [procStat('98765'), procStat('98766')] }),
    )).rejects.toThrow(/process identity or thread-set race/);
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
