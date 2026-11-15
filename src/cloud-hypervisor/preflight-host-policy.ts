import { constants, promises as fs } from 'fs';
import execa from 'execa';
import { CloudHypervisorUnsupportedHostError } from './errors';
import {
  HostPreflightReporter, hostPreflightReason, markHostPreflightError,
} from './host-preflight-progress';
import { resolveTrustedHostTool } from './artifact-trust';
import type { CloudHypervisorHostToolPaths, CloudHypervisorPreflightDependencies } from './preflight';

const CLOUD_HYPERVISOR_HOST_TOOLS: (keyof CloudHypervisorHostToolPaths)[] = [
  'getent', 'getfacl', 'groupdel', 'id', 'ip', 'nft', 'sysctl', 'flock', 'mke2fs', 'debugfs', 'e2fsck',
  'rsync', 'mount', 'umount', 'setfacl', 'setpriv', 'useradd', 'userdel',
];

export const defaultHostPolicyDependencies: Pick<CloudHypervisorPreflightDependencies,
  'assertToolAvailable' | 'assertHostPolicy' | 'assertDockerInfrastructure' | 'resolveKvmGid'
> = {
  assertToolAvailable: (tool) => resolveTrustedHostTool(tool, process.env),
  assertHostPolicy: async (report = new HostPreflightReporter('bounded-runtime')) => {
    await report.check('root', () => {
      if (process.getuid?.() !== 0) {
        throw markHostPreflightError(new CloudHypervisorUnsupportedHostError(
          'Cloud Hypervisor network setup requires root; invoke awf through sudo from a non-root account',
        ), 'requirement-not-met');
      }
    });
    try {
      await report.check('ipv4-control', () => fs.access('/proc/sys/net/ipv4/ip_forward', constants.R_OK));
      await report.check('ipv6-control', () => fs.access('/proc/sys/net/ipv6/conf/all/disable_ipv6', constants.R_OK));
      await report.check('seccomp-control', () => fs.access('/proc/sys/kernel/seccomp/actions_avail', constants.R_OK));
    } catch (error) {
      throw markHostPreflightError(new CloudHypervisorUnsupportedHostError(
        'host kernel policy does not expose required network namespace and seccomp controls: ' +
        `${error instanceof Error ? error.message : String(error)}`,
        error,
      ), hostPreflightReason(error));
    }
    try {
      await report.check('cgroup-v2', () => fs.access('/sys/fs/cgroup/cgroup.controllers', constants.R_OK));
      return 2;
    } catch (error) {
      // Cloud Hypervisor's launcher manages an explicit memory/CPU/PID
      // cgroup for the launched process (see `src/cloud-hypervisor/launcher.ts`
      // `CloudHypervisorCgroup`), which requires the cgroup v2 unified
      // hierarchy's `cgroup.subtree_control` delegation model. A cgroup v1
      // fallback would need separate per-controller mount points
      // (`memory`, `cpu,cpuacct`, `pids`) that this launcher does not
      // manage, so it is rejected explicitly rather than silently
      // constructing a broken cgroup. GitHub-hosted Ubuntu runners (the
      // only supported host) always run cgroup v2.
      throw markHostPreflightError(new CloudHypervisorUnsupportedHostError(
        'Cloud Hypervisor requires the cgroup v2 unified hierarchy ' +
        '(/sys/fs/cgroup/cgroup.controllers); cgroup v1-only hosts are not supported: ' +
        `${error instanceof Error ? error.message : String(error)}`,
        error,
      ), hostPreflightReason(error));
    }
  },
  assertDockerInfrastructure: async (dockerBinaryPath, report = new HostPreflightReporter('bounded-runtime')) => {
    for (const args of [['info'], ['compose', 'version']] as const) {
      await report.check(args[0] === 'info' ? 'docker-info' : 'docker-compose', async () => {
        const result = await execa(dockerBinaryPath, [...args], {
          reject: false,
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.exitCode !== 0) {
          throw markHostPreflightError(new Error(
            `${dockerBinaryPath} ${args.join(' ')} failed with code ${result.exitCode}: ${result.stderr.trim()}`,
          ), 'command-failed');
        }
      });
    }
  },
  resolveKvmGid: async () => {
    const stat = await fs.stat('/dev/kvm');
    return stat.gid;
  },
};

export async function resolvePreflightHostTools(
  report: HostPreflightReporter,
  dependencies: CloudHypervisorPreflightDependencies,
): Promise<Record<keyof CloudHypervisorHostToolPaths, string>> {
  const tools = {} as Record<keyof CloudHypervisorHostToolPaths, string>;
  for (const tool of CLOUD_HYPERVISOR_HOST_TOOLS) {
    try {
      tools[tool] = await report.check(`tool-${tool}`, () => dependencies.assertToolAvailable(tool));
    } catch (error) {
      throw markHostPreflightError(new Error(
        `Cloud Hypervisor requires host tool "${tool}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
      ), hostPreflightReason(error));
    }
  }
  return tools;
}

export async function checkPreflightHostPolicy(
  report: HostPreflightReporter,
  dependencies: CloudHypervisorPreflightDependencies,
  tools: Record<keyof CloudHypervisorHostToolPaths, string>,
): Promise<{ kvmGid: number; cgroupVersion: 2 }> {
  await report.check('platform', () => {
    if (dependencies.platform !== 'linux') {
      throw markHostPreflightError(new CloudHypervisorUnsupportedHostError(
        `Cloud Hypervisor requires Linux with KVM; found ${dependencies.platform}`,
      ), 'requirement-not-met');
    }
  });
  await report.check('architecture', () => {
    if (dependencies.arch !== 'x64') {
      throw markHostPreflightError(new CloudHypervisorUnsupportedHostError(
        `Cloud Hypervisor is supported only on x86_64 GitHub-hosted runners; found Node architecture ${dependencies.arch}`,
      ), 'requirement-not-met');
    }
  });
  try {
    await report.check('kvm-access', () => dependencies.access('/dev/kvm', constants.R_OK | constants.W_OK));
  } catch (error) {
    throw new CloudHypervisorUnsupportedHostError(
      'Cloud Hypervisor requires readable and writable /dev/kvm: ' +
      `${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  const kvmGid = await report.check('kvm-group', () => dependencies.resolveKvmGid());
  let cgroupVersion: 2;
  try {
    cgroupVersion = await report.check('host-policy', () => dependencies.assertHostPolicy(report));
  } catch (error) {
    throw error instanceof CloudHypervisorUnsupportedHostError
      ? error
      : new CloudHypervisorUnsupportedHostError(
        `Cloud Hypervisor host policy is unsupported: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
  }
  let dockerBinaryPath: string;
  try {
    dockerBinaryPath = await report.check('tool-docker', () => dependencies.assertToolAvailable('docker'));
  } catch (error) {
    throw new Error(
      'Cloud Hypervisor requires host tool "docker": ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  tools.docker = dockerBinaryPath;
  await report.check('docker-infrastructure', () => dependencies.assertDockerInfrastructure(dockerBinaryPath, report));
  return { kvmGid, cgroupVersion };
}
