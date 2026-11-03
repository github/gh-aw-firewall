import { promises as fs } from 'fs';
import * as path from 'path';
import type { NvxLayerArtifact } from './filesystem-builder';
import type {
  NvxOneShotExecutionRequest,
  NvxOneShotNetworkPlan,
} from './one-shot-adapter';
import type { NvxOneShotOutcome } from './outcome';

export const NVX_DEFAULT_WORKLOAD_ID = 65534;
export const NVX_ONE_SHOT_CPU_PROFILE = 'host';

export function validateNvxExecutionRequest(request: NvxOneShotExecutionRequest): void {
  if (request.entrypoint.includes('\0') || !request.entrypoint.startsWith('/')) {
    throw new Error('NVX entrypoint must be an absolute path without NUL bytes');
  }
  assertKernelToken(request.entrypoint, 'NVX entrypoint');
  for (const argument of request.args ?? []) {
    assertKernelToken(argument, 'NVX one-shot argument');
  }
  const hostname = request.hostname ?? 'awf-nvx';
  if (
    hostname.length < 1 ||
    hostname.length > 63 ||
    hostname.startsWith('-') ||
    hostname.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(hostname)
  ) {
    throw new Error(`Invalid NVX hostname: ${hostname}`);
  }
  const workloadUid = request.workloadUid ?? NVX_DEFAULT_WORKLOAD_ID;
  const workloadGid = request.workloadGid ?? NVX_DEFAULT_WORKLOAD_ID;
  assertPositiveInteger(workloadUid, 'NVX workload UID');
  assertPositiveInteger(workloadGid, 'NVX workload GID');
  if (workloadUid >= 0xffffffff || workloadGid >= 0xffffffff) {
    throw new Error('NVX workload UID and GID must be at most 4294967294');
  }
  if (
    (request.filesystem.scratch.uid !== workloadUid ||
      request.filesystem.scratch.gid !== workloadGid)
  ) {
    throw new Error(
      `NVX scratch owner ${request.filesystem.scratch.uid}:${request.filesystem.scratch.gid} ` +
      `must match workload identity ${workloadUid}:${workloadGid}`,
    );
  }
  assertOptionalPositiveInteger(request.memoryMaxBytes, 'NVX memory limit');
  assertOptionalPositiveInteger(request.pidsMax, 'NVX process limit');
  assertOptionalPositiveInteger(request.memoryMib, 'NVX guest memory');
  if (request.pidsMax !== undefined && request.pidsMax > 4194303) {
    throw new Error('NVX process limit exceeds 4194303 (including the PID 1 allowance)');
  }
  if (request.memoryMib !== undefined && request.memoryMib > 17592186044415) {
    throw new Error('NVX guest memory overflows its byte representation');
  }
  const cpuProfile = request.cpuProfile ?? NVX_ONE_SHOT_CPU_PROFILE;
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(cpuProfile)) {
    throw new Error(`NVX CPU profile is invalid: ${cpuProfile}`);
  }
  for (const mount of request.mounts ?? []) {
    for (const [label, value] of [
      ['guest target', mount.guestTarget],
      ['host path', mount.hostPath],
      ...mount.deniedPaths.map((value) => ['denied path', value] as const),
      ...mount.allowedPaths.map((value) => ['allowed path', value] as const),
      ...mount.writablePaths.map((value) => ['writable path', value] as const),
    ] as const) {
      if (!path.isAbsolute(value) || value.includes('\0') || value.includes(',') || value.split('/').includes('..')) {
        throw new Error(`NVX mount ${label} must be an absolute path without NUL, commas, or parent components`);
      }
    }
    if (mount.mode !== 'ro' && mount.mode !== 'rw') {
      throw new Error(`NVX mount mode is invalid: ${String(mount.mode)}`);
    }
    if (mount.mode === 'ro' && mount.writablePaths.length > 0) {
      throw new Error(`NVX read-only mount cannot have writable paths: ${mount.guestTarget}`);
    }
    assertKernelToken(mount.guestTarget, 'NVX mount guest target');
    const target = mount.guestTarget;
    if (/[\\=,]/.test(target) || target === '/' ||
      target.slice(1).split('/').some((component) => !component || component === '.') ||
      Buffer.byteLength(target) > 4096) {
      throw new Error('NVX mount guest target must be a canonical non-root path without backslash, equals, or comma');
    }
    if (['/etc', '/run', '/run/nvx'].includes(target) ||
      ['/proc', '/sys', '/dev', '/.nvx-agent', '/etc/machine-id', '/etc/resolv.conf', '/run/nvx/time']
        .some((reserved) => target === reserved || target.startsWith(`${reserved}/`))) {
      throw new Error(`NVX mount guest target is reserved: ${target}`);
    }
    if (mount.file && (
      mount.deniedPaths.length || mount.allowedPaths.length || mount.writablePaths.length
    )) {
      throw new Error('NVX file mount cannot have directory policies');
    }
    for (const paths of [mount.deniedPaths, mount.allowedPaths, mount.writablePaths]) {
      if (paths.length > 128 || new Set(paths).size !== paths.length ||
        paths.some((candidate) => !isWithin(candidate, mount.hostPath))) {
        throw new Error('NVX mount policy must contain at most 128 distinct paths inside its share');
      }
    }
    if (mount.allowedPaths.some((allowed) =>
      !mount.deniedPaths.some((denied) => isWithin(allowed, denied)))) {
      throw new Error('NVX allowed path must be inside a denied path');
    }
  }
  const mounts = request.mounts ?? [];
  for (const [index, mount] of mounts.entries()) {
    for (const other of mounts.slice(0, index)) {
      if (pathsOverlap(mount.guestTarget, other.guestTarget) ||
        pathsOverlap(mount.hostPath, other.hostPath)) {
        throw new Error('NVX mount targets and host paths must not overlap');
      }
    }
  }
  assertOptionalPositiveInteger(request.timeoutMs, 'NVX timeout');
  assertIpv4Cidr(request.network.guestAddress, 'NVX guest network address');
  if (request.network.proxyAddress !== undefined) {
    assertIpv4Endpoint(request.network.proxyAddress, 'NVX network proxy address');
  }

  function assertKernelToken(value: string, label: string): void {
    const bytes = Buffer.from(value);
    if (!value || /[\s\p{Cc}"]/u.test(value) ||
      bytes.some((byte) => byte === 0xa0 || (byte >= 9 && byte <= 13) || byte === 32)) {
      throw new Error(`${label} must be nonempty without whitespace, control characters, or double quotes`);
    }
  }

  function pathsOverlap(left: string, right: string): boolean {
    return isWithin(left, right) || isWithin(right, left);
  }

  function isWithin(candidate: string, root: string): boolean {
    return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`);
  }
  for (const value of [
    ...(request.network.egressAllow ?? []),
    ...(request.network.egressDeny ?? []),
    ...(request.network.hostLoopbackForwards ?? []),
  ]) {
    if (!value || value.includes('\0') || /\s/.test(value)) {
      throw new Error(`Invalid NVX network rule: ${value}`);
    }
  }
}

export function orderedLayers(layers: readonly NvxLayerArtifact[]): readonly NvxLayerArtifact[] {
  const order = new Map([
    ['distro', 0],
    ['runtime', 1],
    ['custom', 2],
  ]);
  return [...layers].sort((left, right) =>
    (order.get(left.role) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.role) ?? Number.MAX_SAFE_INTEGER)
  );
}

export async function assertRegularFile(filePath: string, label: string) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return stat;
}

export function assertSafeDiskPath(filePath: string): void {
  if (filePath.includes(',') || filePath.includes(';') || filePath.includes('\0')) {
    throw new Error(`NVX disk path contains an unsupported delimiter: ${filePath}`);
  }
}

export function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertOptionalPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined) assertPositiveInteger(value, label);
}

export function assertUuid(value: string, label: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${label} must be a canonical lowercase UUID`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

export function assertNetworkPolicy(
  requested: NvxOneShotNetworkPlan,
  outcome: NvxOneShotOutcome,
): void {
  const expectedHostLoopback = (requested.hostLoopbackForwards?.length ?? 0) > 0
    ? 'allow'
    : 'deny';
  const expectedAllowRules = requested.egressAllow?.length ?? 0;
  const expectedDenyRules = requested.egressDeny?.length ?? 0;
  if (
    outcome.networkPolicy.status !== 'applied' ||
    outcome.networkPolicy.statusCode !== 0 ||
    outcome.networkPolicy.mode !== 'rules' ||
    outcome.networkPolicy.allowRuleCount !== expectedAllowRules ||
    outcome.networkPolicy.denyRuleCount !== expectedDenyRules ||
    outcome.networkPolicy.hostLoopback !== expectedHostLoopback
  ) {
    throw new Error(
      'NVX structured network policy does not match the requested fail-closed policy',
    );
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertIpv4Cidr(value: string, label: string): void {
  const [address, prefix, ...extra] = value.split('/');
  if (
    extra.length > 0 ||
    !isIpv4Address(address) ||
    prefix === undefined ||
    !Number.isInteger(Number(prefix)) ||
    Number(prefix) < 0 ||
    Number(prefix) > 32
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertIpv4Endpoint(value: string, label: string): void {
  const separator = value.lastIndexOf(':');
  const address = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (
    separator < 1 ||
    !isIpv4Address(address) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const numeric = Number(octet);
    return numeric >= 0 && numeric <= 255 && String(numeric) === octet;
  });
}
