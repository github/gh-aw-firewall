import { createHash } from 'crypto';
import type { NvxLiveMount } from './live-mount-policy';
import type { NvxOneShotExecutionRequest } from './one-shot-adapter';
import {
  NVX_DEFAULT_WORKLOAD_ID,
  orderedLayers,
  validateNvxExecutionRequest,
} from './one-shot-validation';

export function buildNvxOneShotArguments(
  request: NvxOneShotExecutionRequest,
  outcomePath: string,
): readonly string[] {
  validateNvxExecutionRequest(request);
  buildNvxKernelCommandLine(request);
  const uid = request.workloadUid ?? NVX_DEFAULT_WORKLOAD_ID;
  const gid = request.workloadGid ?? NVX_DEFAULT_WORKLOAD_ID;
  const args = [
    'sandbox',
    'run',
  ];
  for (const layer of orderedLayers(request.filesystem.layers)) {
    args.push('--layer', `${layer.role},${layer.path},${layer.uuid}`);
  }
  for (const mount of request.mounts ?? []) {
    args.push('--mount', `${mount.guestTarget},${mount.hostPath},${mount.mode}`);
    for (const denied of mount.deniedPaths) args.push('--mount-deny', denied);
    for (const allowed of mount.allowedPaths) args.push('--mount-allow', allowed);
    for (const writable of mount.writablePaths) args.push('--mount-write', writable);
  }
  if (request.mounts?.length) args.push('--mount-owner', 'caller');
  args.push(
    '--scratch', request.filesystem.scratch.path,
    '--entrypoint', request.entrypoint,
  );
  for (const argument of request.args ?? []) args.push(`--arg=${argument}`);
  args.push(
    '--hostname', request.hostname ?? 'awf-nvx',
    '--workload-user', `${uid}:${gid}`,
  );
  if (request.memoryMaxBytes !== undefined) {
    args.push('--memory-max', String(request.memoryMaxBytes));
  }
  if (request.pidsMax !== undefined) args.push('--pids-max', String(request.pidsMax));
  args.push(
    '--memory-mib', String(request.memoryMib ?? 512),
    '--hypervisor', 'kvm',
    '--net', request.network.guestAddress,
    '--network-profile', 'portable',
    '--network-egress', 'deny',
    '--network-ingress', 'deny',
  );
  for (const rule of request.network.egressAllow ?? []) {
    args.push('--network-egress-allow', rule);
  }
  for (const rule of request.network.egressDeny ?? []) {
    args.push('--network-egress-deny', rule);
  }
  const forwards = request.network.hostLoopbackForwards ?? [];
  args.push('--host-loopback', forwards.length > 0 ? 'allow' : 'deny');
  if (request.network.proxyAddress !== undefined) {
    args.push('--network-proxy', request.network.proxyAddress);
  }
  for (const forward of forwards) args.push('--host-loopback-forward', forward);
  args.push('--outcome-report', outcomePath);
  return args;
}

export function appendMountArguments(
  args: string[],
  mounts: readonly NvxLiveMount[],
): void {
  const aggregate = usesNvxAggregateMount(mounts);
  if (aggregate) args.push('--mount-aggregate', '/run/nvx/shares');
  for (const [index, mount] of mounts.entries()) {
    args.push(
      aggregate ? '--mount-child' : '--mount',
      aggregate
        ? `${nvxShareName(index, mount.guestTarget)},${mount.hostPath},${mount.mode}${mount.file ? ',file' : ''}`
        : `${mount.guestTarget},${mount.hostPath},${mount.mode}`,
    );
    for (const denied of mount.deniedPaths) args.push('--mount-deny', denied);
    for (const allowed of mount.allowedPaths) args.push('--mount-allow', allowed);
    for (const writable of mount.writablePaths) args.push('--mount-write', writable);
  }
  if (mounts.length > 0) args.push('--mount-owner', 'caller');
}

export function usesNvxAggregateMount(mounts: readonly NvxLiveMount[]): boolean {
  return mounts.length > 1 || mounts.some((mount) => mount.file);
}

export function nvxShareName(index: number, target: string): string {
  return `${index}-${createHash('sha256').update(target).digest('hex').slice(0, 32)}`;
}

export function buildNvxKernelCommandLine(request: NvxOneShotExecutionRequest): string {
  const layers = request.filesystem.layers;
  if (layers.length !== 1 || layers[0].role !== 'distro') {
    throw new Error('NVX launch requires exactly one distro layer');
  }
  const tokens = [
    'nvx_sandbox=1',
    `nvx_layer=distro,0xd0003000,erofs:${layers[0].uuid}`,
    'nvx_scratch=0xd0006000,ext4',
    `nvx_entrypoint=${request.entrypoint}`,
    `nvx_hostname=${request.hostname ?? 'awf-nvx'}`,
  ];
  for (const argument of request.args ?? []) tokens.push(`nvx_arg=${argument}`);
  const mounts = request.mounts ?? [];
  const aggregate = usesNvxAggregateMount(mounts);
  if (aggregate) {
    for (const [index, mount] of mounts.entries()) {
      tokens.push(
        `nvx_share=${nvxShareName(index, mount.guestTarget)},${mount.guestTarget},${mount.mode}${mount.file ? ',file' : ''}`,
      );
    }
  }
  if (request.memoryMaxBytes !== undefined) tokens.push(`nvx_memory_max=${request.memoryMaxBytes}`);
  if (request.pidsMax !== undefined) tokens.push(`nvx_pids_max=${request.pidsMax + 1}`);
  const commandLine = tokens.join(' ');
  let fragment = '';
  if (mounts.length) {
    const target = aggregate ? '/run/nvx/shares' : mounts[0].guestTarget;
    const mode = mounts.some((mount) => mount.mode === 'rw') ? 'rw' : 'ro';
    fragment = ` virtfs_dir=${target} virtfs_tag=microvm virtfs_mode=${mode}` +
      (aggregate ? ' virtfs_aggregate=1' : '');
  }
  if (Buffer.byteLength(commandLine + fragment) + 1 > 1024) {
    throw new Error('NVX sandbox kernel command line exceeds its 1024-byte x86 budget');
  }
  return commandLine;
}

export function buildNvxHostEnvironment(runDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: runDirectory,
  };
  return environment;
}
