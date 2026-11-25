import * as path from 'path';
import {
  createMicrovmNetworkPlan,
  generateMicrovmNftRuleset,
  type MicrovmControlPeer,
  type MicrovmNetworkPlan,
  type MicrovmNetworkPlanOptions,
} from '../microvm/network';
import {
  buildNvxConstrainedLaunchCommand,
  computeNvxCgroupLimits,
  type NvxCgroupLimits,
  type NvxLaunchCommand,
} from './confinement';
import type { NvxFilesystemBundle } from './filesystem-builder';
import type { NvxRuntimeToolPaths, NvxVmmIdentity } from './identity';
import {
  appendMountArguments,
  buildNvxKernelCommandLine,
  NVX_ONE_SHOT_CPU_PROFILE,
  validateNvxExecutionRequest,
  type NvxOneShotExecutionRequest,
} from './one-shot-adapter';
import type { NvxLiveMount } from './live-mount-policy';
import {
  NVX_GUEST_ARTIFACT_ROOT,
  assertNvxRunLayout,
  createNvxRunLayout,
  toNvxGuestRunPath,
  type NvxRunLayout,
} from './run-layout';

const NVX_HOST_PIDS_MAX = 256;

export interface NvxPhase3dLaunchPlan {
  readonly layout: NvxRunLayout;
  readonly identity: NvxVmmIdentity;
  readonly cgroupLimits: NvxCgroupLimits;
  readonly networkPlan: MicrovmNetworkPlan;
  readonly networkRuleset: string;
  readonly launchCommand: NvxLaunchCommand;
  readonly outcomePath: string;
}

export function createNvxNetworkPlan(
  runId: string,
  options: MicrovmNetworkPlanOptions,
): MicrovmNetworkPlan {
  const plan = createMicrovmNetworkPlan(runId, options);
  return bindNvxNetworkPlan(runId, plan);
}

export function bindNvxNetworkPlan(
  runId: string,
  plan: MicrovmNetworkPlan,
): MicrovmNetworkPlan {
  const layout = createNvxRunLayout(runId);
  if (plan.runId !== runId) {
    throw new Error('NVX network allocation is not bound to the run identity');
  }
  return {
    ...plan,
    namespaceName: layout.networkNamespace,
    netnsPath: `/var/run/netns/${layout.networkNamespace}`,
    nftTableName: `awf_nvx_${plan.resourceToken}`,
  };
}

export function buildNvxPhase3dLaunchPlan(options: {
  readonly runId: string;
  readonly tools: NvxRuntimeToolPaths;
  readonly identity: NvxVmmIdentity;
  readonly filesystem: NvxFilesystemBundle;
  readonly execution: Omit<NvxOneShotExecutionRequest, 'nvxRoot' | 'filesystem' | 'network'>;
  readonly network: {
    readonly infrastructureBridge: string;
    readonly enableApiProxy: boolean;
    readonly controlPeers?: readonly MicrovmControlPeer[];
  };
  readonly networkPlan?: MicrovmNetworkPlan;
}): NvxPhase3dLaunchPlan {
  const layout = createNvxRunLayout(options.runId);
  assertNvxRunLayout(layout);
  if (path.resolve(options.filesystem.runDirectory) !== layout.runDirectory) {
    throw new Error(
      'NVX filesystem bundle must be staged in the canonical run directory ' +
      `${layout.runDirectory} (build it with useCanonicalRunDirectory)`,
    );
  }
  const networkPlan = options.networkPlan ?? createNvxNetworkPlan(options.runId, {
      infrastructureBridge: options.network.infrastructureBridge,
      enableApiProxy: options.network.enableApiProxy,
      tapOwnerUid: options.identity.uid,
      tapOwnerGid: options.identity.gid,
      controlPeers: options.network.controlPeers,
      createTap: false,
    });
  if (
    networkPlan.runId !== options.runId ||
    networkPlan.namespaceName !== layout.networkNamespace ||
    networkPlan.tapOwnerUid !== options.identity.uid ||
    networkPlan.tapOwnerGid !== options.identity.gid
  ) {
    throw new Error('NVX launch plan network allocation is not bound to the run identity');
  }
  const cgroupLimits = computeNvxCgroupLimits({
    guestMemoryMib: options.execution.memoryMib ?? 512,
    vcpuCount: 1,
    hostPidsMax: NVX_HOST_PIDS_MAX,
  });
  const outcomePath = path.join(layout.runDirectory, 'outcome.json');
  const guestFilesystem = toNvxGuestFilesystemBundle(layout, options.filesystem);
  const guestOutcomePath = toNvxGuestRunPath(layout, outcomePath);
  const liveMounts = toJailedLiveMounts(options.execution.mounts ?? []);
  const openvmmArguments = buildDirectOpenvmmArguments({
    ...options.execution,
    nvxRoot: NVX_GUEST_ARTIFACT_ROOT,
    filesystem: guestFilesystem,
    mounts: liveMounts.map(({ mount }) => mount),
    network: {
      guestAddress: `${networkPlan.guestIp}/${networkPlan.guestPrefixLength}`,
      egressAllow: networkPlan.allowedEndpoints.map(
        (endpoint) => `${endpoint.ip}/32:tcp:${endpoint.port}`,
      ),
    },
  }, guestOutcomePath);
  return {
    layout,
    identity: options.identity,
    cgroupLimits,
    networkPlan,
    networkRuleset: generateMicrovmNftRuleset(networkPlan),
    launchCommand: buildNvxConstrainedLaunchCommand({
      tools: {
        ip: options.tools.ip,
        bwrap: options.tools.bwrap,
        setpriv: options.tools.setpriv,
      },
      namespaceName: layout.networkNamespace,
      identity: options.identity,
      nvxRoot: layout.artifactSnapshotDirectory,
      runDirectory: layout.runDirectory,
      systemReadOnlyPaths: [
        '/usr',
        '/bin',
        '/sbin',
        '/lib',
        '/lib64',
        '/etc/ssl',
      ],
      shareRoots: liveMounts.map(({ source, mount }) => ({
        source,
        jailPath: mount.hostPath,
        mode: mount.mode,
      })),
      openvmmArguments,
    }),
    outcomePath,
  };
}

export function buildDirectOpenvmmArguments(
  request: NvxOneShotExecutionRequest,
  outcomePath: string,
): readonly string[] {
  validateNvxExecutionRequest(request);
  const uid = request.workloadUid ?? 65534;
  const gid = request.workloadGid ?? 65534;
  const ordered = request.filesystem.layers;
  if (ordered.length !== 1 || ordered[0].role !== 'distro') {
    throw new Error('NVX launch requires exactly one distro layer');
  }
  const args: string[] = ['--machine', 'microvm', '--paused'];
  for (const layer of ordered) {
    args.push(
      '--microvm-sandbox-block',
      `${layer.role}:file:/proc/self/fd/6,ro`,
    );
  }
  args.push(
    '--microvm-sandbox-block',
    'scratch:file:/proc/self/fd/7',
    '--microvm-workload-identity',
    `${uid}:${gid}`,
    '--microvm-lifecycle',
    'one-shot',
    '--single-process',
    '--hypervisor',
    'kvm',
    '--cpu-profile',
    request.cpuProfile ?? NVX_ONE_SHOT_CPU_PROFILE,
    '--memory',
    `${request.memoryMib ?? 512}M`,
    '--kernel',
    path.join(request.nvxRoot, 'vmlinux'),
    '--initrd',
    path.join(request.nvxRoot, 'initramfs.cpio.gz'),
    '--cmdline',
    buildNvxKernelCommandLine(request),
    '--net',
    request.network.guestAddress,
    '--network-profile',
    'portable',
    '--network-egress',
    'deny',
    '--network-ingress',
    'deny',
  );
  appendMountArguments(args, request.mounts ?? []);
  for (const rule of request.network.egressAllow ?? []) {
    args.push('--network-egress-allow', rule);
  }
  for (const rule of request.network.egressDeny ?? []) {
    args.push('--network-egress-deny', rule);
  }
  const forwards = request.network.hostLoopbackForwards ?? [];
  args.push(
    '--host-loopback', forwards.length > 0 ? 'allow' : 'deny',
  );
  if (request.network.proxyAddress !== undefined) {
    args.push('--network-proxy', request.network.proxyAddress);
  }
  for (const forward of forwards) args.push('--host-loopback-forward', forward);
  args.push('--microvm-report', outcomePath);
  return args;
}

function toJailedLiveMounts(
  mounts: readonly NvxLiveMount[],
): Array<{ source: string; mount: NvxLiveMount }> {
  return mounts.map((mount) => {
    const jailPath = path.posix.join('/mnt/awf-nvx-shares', mount.tag);
    const translate = (candidate: string): string => {
      const relative = path.relative(mount.hostPath, candidate);
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          `NVX mount policy path is outside share ${mount.guestTarget}: ${candidate}`,
        );
      }
      return relative ? path.join(jailPath, relative) : jailPath;
    };
    return {
      source: mount.hostPath,
      mount: {
        ...mount,
        hostPath: jailPath,
        deniedPaths: mount.deniedPaths.map(translate),
        allowedPaths: mount.allowedPaths.map(translate),
        writablePaths: mount.writablePaths.map(translate),
      },
    };
  });
}

function toNvxGuestFilesystemBundle(
  layout: NvxRunLayout,
  bundle: NvxFilesystemBundle,
): NvxFilesystemBundle {
  return {
    ...bundle,
    runDirectory: toNvxGuestRunPath(layout, bundle.runDirectory),
    manifestPath: toNvxGuestRunPath(layout, bundle.manifestPath),
    layers: bundle.layers.map((layer) => ({
      ...layer,
      path: toNvxGuestRunPath(layout, layer.path),
    })),
    scratch: {
      ...bundle.scratch,
      path: toNvxGuestRunPath(layout, bundle.scratch.path),
    },
  };
}
