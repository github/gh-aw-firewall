import { promises as fs } from 'fs';
import * as path from 'path';
import type { CloudHypervisorLandlockRule } from './api-client';

/**
 * Secure host launch-argv construction and resource-confinement helpers for
 * Cloud Hypervisor.
 *
 * Cloud Hypervisor has no jailer-equivalent process (unlike Firecracker), so
 * there is nothing that natively joins a prepared network namespace,
 * chroots, drops capabilities, and execs the VMM as one atomic operation.
 * This module documents and implements the exact replacement boundary AWF
 * uses instead:
 *
 *  1. **Network namespace join** — `ip netns exec <namespace> ...` (the
 *     already-trusted, already-required `ip` tool) execs directly into the
 *     per-run namespace {@link https://man7.org/linux/man-pages/man8/ip-netns.8.html}
 *     without an intermediate fork, so the resulting process keeps the PID
 *     the host process observes.
 *  2. **Privilege drop** — `setpriv --reuid --regid --clear-groups
 *     --no-new-privs --inh-caps=-all --bounding-set=-all` execs the Cloud
 *     Hypervisor binary as the non-root operator uid/gid with an empty
 *     capability bounding set and `no_new_privs` set, before any guest code
 *     runs. This is the same non-root identity Firecracker's jailer targets
 *     (see `resolveJailerIdentity` in `src/firecracker/manager.ts`) and
 *     requires the same operator preconditions (kvm-group membership,
 *     `/dev/kvm` access).
 *  3. **Filesystem confinement** — Cloud Hypervisor has no chroot of its
 *     own, and jailer's userspace chroot+pivot_root cannot be replicated
 *     for a foreign static binary without reimplementing jailer itself.
 *     Instead AWF combines:
 *       - a **private run directory** (mode `0700`, owned by the target
 *         uid/gid) holding only the staged kernel/rootfs/workspace images
 *         and the API/vsock sockets — see `CloudHypervisorManager`;
 *       - **Landlock** (`landlock_enable`/`landlock_rules` in the
 *         `vm.create` payload — see {@link computeCloudHypervisorLandlockRules})
 *         restricting the VMM process's own filesystem access to exactly
 *         those paths, enforced by the kernel LSM rather than a userspace
 *         boundary;
 *       - Cloud Hypervisor's own **default seccomp** filter
 *         (`--seccomp true`, its default "kill on violation" mode).
 *     This is a different (kernel-LSM-based) boundary than jailer's chroot,
 *     not a weaker one — it is intentionally documented and covered by
 *     tests instead of silently degrading to "no filesystem confinement".
 *  4. **Resource limits** — a dedicated cgroup (v1 or v2, matching
 *     preflight's detected version) bounding memory and CPU time, created
 *     before launch and assigned by PID immediately after spawn (see
 *     {@link CloudHypervisorCgroup}).
 *
 * No shell is ever invoked: every argv below is passed as a plain array to
 * `execa`, never interpolated into a shell string.
 */

export const CLOUD_HYPERVISOR_GUEST_CID = 3;

export interface CloudHypervisorLaunchPaths {
  readonly kernelPath: string;
  readonly rootfsPath: string;
  readonly workspacePath?: string;
  readonly runDirectory: string;
  readonly apiSocketPath: string;
  readonly vsockSocketPath: string;
}

export interface CloudHypervisorLaunchIdentity {
  readonly uid: number;
  readonly gid: number;
}

export interface CloudHypervisorLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CloudHypervisorLaunchToolPaths {
  readonly ip: string;
  readonly setpriv: string;
}

/**
 * Builds the argv AWF spawns to launch Cloud Hypervisor: join the prepared
 * network namespace, drop to the non-root operator identity with an empty
 * capability bounding set, then exec the pinned Cloud Hypervisor binary
 * with only its API socket configured (the VM itself is created and booted
 * afterwards over that socket, mirroring Firecracker's `--api-sock`-only
 * jailer invocation).
 *
 * The launched process retains exactly one supplementary group: the group
 * that owns `/dev/kvm` (resolved by preflight). A blanket `--clear-groups`
 * would also drop that membership, and since the documented supported
 * setup relies on kvm-group access for the non-root operator identity
 * (see docs/cloud-hypervisor-foundation.md), that would make every real
 * launch fail with EACCES opening `/dev/kvm` even though preflight (which
 * runs as root) passed.
 */
export function buildCloudHypervisorLaunchCommand(options: {
  readonly tools: CloudHypervisorLaunchToolPaths;
  readonly namespaceName: string;
  readonly identity: CloudHypervisorLaunchIdentity;
  readonly kvmGid: number;
  readonly cloudHypervisorBinary: string;
  readonly apiSocketPath: string;
  readonly logFilePath: string;
}): CloudHypervisorLaunchCommand {
  assertSafeNamespaceName(options.namespaceName);
  assertPositiveIdentity(options.identity.uid, 'uid');
  assertPositiveIdentity(options.identity.gid, 'gid');
  if (!Number.isSafeInteger(options.kvmGid) || options.kvmGid < 0) {
    throw new Error(`Cloud Hypervisor launch /dev/kvm group id must be a non-negative integer: ${options.kvmGid}`);
  }
  if (!path.isAbsolute(options.cloudHypervisorBinary)) {
    throw new Error(`Cloud Hypervisor binary path must be absolute: ${options.cloudHypervisorBinary}`);
  }
  if (!path.isAbsolute(options.apiSocketPath)) {
    throw new Error(`Cloud Hypervisor API socket path must be absolute: ${options.apiSocketPath}`);
  }

  return {
    command: options.tools.ip,
    args: [
      'netns', 'exec', options.namespaceName,
      options.tools.setpriv,
      `--reuid=${options.identity.uid}`,
      `--regid=${options.identity.gid}`,
      // Replaces the operator's full supplementary group list with only
      // the /dev/kvm-owning group, instead of --clear-groups (which would
      // also drop kvm access).
      `--groups=${options.kvmGid}`,
      '--no-new-privs',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--',
      options.cloudHypervisorBinary,
      '--api-socket', `path=${options.apiSocketPath}`,
      '--log-file', options.logFilePath,
      '-v',
      '--seccomp', 'true',
    ],
  };
}

/**
 * Computes the minimal set of Landlock filesystem rules Cloud Hypervisor's
 * own process needs after `vm.create`: read access to the kernel image,
 * read-write access to the rootfs and (if present) workspace disk images,
 * read-write access to the private run directory (for the API and vsock
 * UNIX domain sockets it creates there), and read-write access to the
 * device nodes it must reopen for virtio-net TAP attachment and KVM
 * ioctls. Any path not listed here becomes inaccessible to the Cloud
 * Hypervisor process the instant Landlock is enabled, even to a
 * hypothetical guest-escape.
 */
export function computeCloudHypervisorLandlockRules(
  paths: CloudHypervisorLaunchPaths,
): CloudHypervisorLandlockRule[] {
  const rules: CloudHypervisorLandlockRule[] = [
    { path: paths.kernelPath, access: 'r' },
    { path: paths.rootfsPath, access: 'rw' },
    { path: paths.runDirectory, access: 'rw' },
    { path: '/dev/kvm', access: 'rw' },
    { path: '/dev/net/tun', access: 'rw' },
  ];
  if (paths.workspacePath) {
    rules.push({ path: paths.workspacePath, access: 'rw' });
  }
  return rules;
}

export interface CloudHypervisorResourceLimits {
  readonly memoryMib: number;
  readonly vcpuCount: number;
}

/** Fixed VMM/guest-overhead headroom added on top of configured guest memory. */
const CGROUP_MEMORY_HEADROOM_MIB = 256;
/** Bounds the number of Cloud Hypervisor host threads/tasks (defense in depth; it is a single process). */
const CGROUP_MAX_PIDS = 256;
const CGROUP_V2_PERIOD_US = 100_000;
const CGROUP_V2_CONTROLLERS = '+cpu +memory +pids';

export interface CloudHypervisorCgroupDependencies {
  mkdir(directory: string): Promise<unknown>;
  writeFile(filePath: string, contents: string): Promise<void>;
  /** Removes exactly the (now-empty) leaf cgroup directory. cgroupfs's
   * controller/interface files are virtual and cannot be `unlink()`ed, so
   * this must be a plain `rmdir`, not a recursive tree removal. */
  rmdir(directory: string): Promise<void>;
}

const defaultCgroupDependencies: CloudHypervisorCgroupDependencies = {
  mkdir: (directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 }),
  writeFile: (filePath, contents) => fs.writeFile(filePath, contents),
  rmdir: (directory) => fs.rmdir(directory),
};

/**
 * Places one Cloud Hypervisor run under an explicit memory/CPU/PID cgroup,
 * created before launch and assigned by PID immediately after spawn (moving
 * a PID into `cgroup.procs` requires only host-root write access to that
 * file, not any privilege from the moved process itself).
 *
 * Cgroup v2 only: `runCloudHypervisorPreflight` rejects cgroup v1-only
 * hosts explicitly rather than falling back to a v1 hierarchy this class
 * does not manage (v1's memory/cpu/pids controllers live under separate
 * per-controller mount points, not a single directory).
 */
export class CloudHypervisorCgroup {
  private created = false;

  constructor(
    readonly cgroupPath: string,
    private readonly limits: CloudHypervisorResourceLimits,
    private readonly dependencies: CloudHypervisorCgroupDependencies = defaultCgroupDependencies,
  ) {}

  async setup(): Promise<void> {
    // cgroup v2 only materializes a controller's interface files
    // (memory.max, cpu.max, pids.max, ...) in a directory once that
    // controller is enabled in the *parent's* `cgroup.subtree_control`.
    // That delegation has to happen at every level from the cgroup root
    // down to (but excluding) the leaf we actually place limits on.
    const parentDir = path.dirname(this.cgroupPath);
    const rootDir = path.dirname(parentDir);
    await this.enableControllers(rootDir);
    await this.dependencies.mkdir(parentDir);
    await this.enableControllers(parentDir);
    await this.dependencies.mkdir(this.cgroupPath);
    this.created = true;

    const memoryMaxBytes = (this.limits.memoryMib + CGROUP_MEMORY_HEADROOM_MIB) * 1024 * 1024;
    const cpuQuotaUs = this.limits.vcpuCount * CGROUP_V2_PERIOD_US;
    await this.dependencies.writeFile(path.join(this.cgroupPath, 'memory.max'), String(memoryMaxBytes));
    await this.dependencies.writeFile(
      path.join(this.cgroupPath, 'cpu.max'),
      `${cpuQuotaUs} ${CGROUP_V2_PERIOD_US}`,
    );
    await this.dependencies.writeFile(path.join(this.cgroupPath, 'pids.max'), String(CGROUP_MAX_PIDS));
  }

  async assign(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Cannot assign an invalid PID to the Cloud Hypervisor cgroup: ${pid}`);
    }
    await this.dependencies.writeFile(path.join(this.cgroupPath, 'cgroup.procs'), String(pid));
  }

  async cleanup(): Promise<void> {
    if (!this.created) return;
    await this.dependencies.rmdir(this.cgroupPath);
    this.created = false;
  }

  private async enableControllers(directory: string): Promise<void> {
    await this.dependencies.writeFile(
      path.join(directory, 'cgroup.subtree_control'),
      CGROUP_V2_CONTROLLERS,
    );
  }
}

function assertSafeNamespaceName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`Unsafe Cloud Hypervisor network namespace name: ${value}`);
  }
}

function assertPositiveIdentity(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Cloud Hypervisor launch ${label} must be a positive integer`);
  }
}
