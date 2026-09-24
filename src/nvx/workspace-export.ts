import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Guest-visible layout of an NVX one-shot microVM run.
 *
 * The NVX guest assembles its root filesystem as an overlay whose lower layers
 * are the read-only `distro`/`runtime`/`custom` EROFS devices and whose upper
 * layer lives on the writable `scratch` device. AWF owns the `custom` layer, so
 * every host directory AWF exports into the guest is staged there at its
 * guest-absolute path and becomes writable through the overlay upper layer.
 */
export const NVX_GUEST_WORKSPACE = '/workspace';
export const NVX_GUEST_HOME = `${NVX_GUEST_WORKSPACE}/.awf-home`;
/** Guest path of the AWF-generated per-run entrypoint script. */
export const NVX_GUEST_RUN_SCRIPT = '/etc/awf/nvx-run.sh';
/**
 * Directory inside the writable scratch filesystem that backs the guest
 * overlay's upper layer (`upperdir=$scratch/upper`). Everything the guest
 * workload writes to an exported directory lands here, which is what makes a
 * post-run copy-back possible without any guest cooperation.
 */
export const NVX_SCRATCH_UPPER_DIRECTORY = 'upper';

export const NVX_MOUNT_POLICIES = [
  'workspace-only',
  'workspace-and-tool-cache',
] as const;
export type NvxMountPolicy = typeof NVX_MOUNT_POLICIES[number];
export const NVX_DEFAULT_MOUNT_POLICY: NvxMountPolicy = 'workspace-only';

export type NvxExportMode = 'ro' | 'rw';

export interface NvxDirectoryExport {
  readonly tag: string;
  /** Absolute, realpath-canonical host directory staged into the custom layer. */
  readonly source: string;
  /** Absolute guest path the directory is staged at. */
  readonly target: string;
  readonly mode: NvxExportMode;
}

export interface NvxExportEnvironment {
  readonly GITHUB_WORKSPACE?: string;
  readonly RUNNER_TOOL_CACHE?: string;
  readonly AGENT_TOOLSDIRECTORY?: string;
}

const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/;
const MAX_EXPORTS = 2;

/** Tag of the mandatory, always-present workspace export. */
export const NVX_WORKSPACE_EXPORT_TAG = 'workspace';

/**
 * Resolves the host directories exported into the NVX guest for one run.
 *
 * `workspace-only` (the default) exports just `$GITHUB_WORKSPACE`
 * read-write. `workspace-and-tool-cache` additionally exports the runner tool
 * cache read-only, mirroring the Cloud Hypervisor mount policies.
 */
export async function resolveNvxExports(
  environment: NvxExportEnvironment = process.env,
  cwd: string = process.cwd(),
  mountPolicy: NvxMountPolicy = NVX_DEFAULT_MOUNT_POLICY,
): Promise<NvxDirectoryExport[]> {
  if (!NVX_MOUNT_POLICIES.includes(mountPolicy)) {
    throw new Error(`Unsupported NVX mount policy: ${String(mountPolicy)}`);
  }
  const candidates: NvxDirectoryExport[] = [
    {
      tag: NVX_WORKSPACE_EXPORT_TAG,
      source: environment.GITHUB_WORKSPACE || cwd,
      target: NVX_GUEST_WORKSPACE,
      mode: 'rw',
    },
  ];
  if (mountPolicy === 'workspace-and-tool-cache') {
    const toolCache = environment.RUNNER_TOOL_CACHE || environment.AGENT_TOOLSDIRECTORY;
    if (!toolCache) {
      throw new Error(
        'NVX mount policy "workspace-and-tool-cache" requires ' +
        'RUNNER_TOOL_CACHE or AGENT_TOOLSDIRECTORY',
      );
    }
    candidates.push({
      tag: 'runner-tool-cache',
      source: toolCache,
      target: toolCache,
      mode: 'ro',
    });
  }
  const resolved: NvxDirectoryExport[] = [];
  for (const candidate of candidates) {
    resolved.push({ ...candidate, source: await canonicalDirectory(candidate) });
  }
  validateNvxExports(resolved);
  return resolved;
}

/**
 * Fail-closed structural validation of a resolved export layout. Kept separate
 * from {@link resolveNvxExports} so callers that assemble exports themselves
 * (tests, future workload profiles) are held to the same invariants.
 */
export function validateNvxExports(exports: readonly NvxDirectoryExport[]): void {
  if (exports.length === 0 || exports.length > MAX_EXPORTS) {
    throw new Error(
      `NVX requires between 1 and ${MAX_EXPORTS} guest exports; received ${exports.length}`,
    );
  }
  const workspace = exports.find((entry) => entry.tag === NVX_WORKSPACE_EXPORT_TAG);
  if (!workspace) {
    throw new Error('NVX guest exports must include a "workspace" export');
  }
  if (workspace.target !== NVX_GUEST_WORKSPACE) {
    throw new Error(
      `NVX workspace export must be staged at ${NVX_GUEST_WORKSPACE}; found ${workspace.target}`,
    );
  }
  const tags = new Set<string>();
  for (const entry of exports) {
    if (!SAFE_TAG.test(entry.tag)) {
      throw new Error(`Unsafe NVX export tag: ${entry.tag}`);
    }
    if (tags.has(entry.tag)) {
      throw new Error(`Duplicate NVX export tag: ${entry.tag}`);
    }
    tags.add(entry.tag);
    if (!path.isAbsolute(entry.source) || path.normalize(entry.source) !== entry.source) {
      throw new Error(`NVX export source must be an absolute normalized path: ${entry.source}`);
    }
    if (!path.isAbsolute(entry.target) || path.normalize(entry.target) !== entry.target) {
      throw new Error(`NVX export target must be an absolute normalized path: ${entry.target}`);
    }
    if (entry.target === '/') {
      throw new Error('NVX exports must not be staged at the guest filesystem root');
    }
    if (isReservedGuestTarget(entry.target)) {
      throw new Error(
        `NVX export target collides with an AWF-owned guest path: ${entry.target}`,
      );
    }
  }
  for (const outer of exports) {
    for (const inner of exports) {
      if (outer === inner) continue;
      if (isWithin(inner.target, outer.target)) {
        throw new Error(
          `NVX export targets must not nest: ${inner.target} is inside ${outer.target}`,
        );
      }
      if (isWithin(inner.source, outer.source)) {
        throw new Error(
          `NVX export sources must not nest: ${inner.source} is inside ${outer.source}`,
        );
      }
    }
  }
}

function isReservedGuestTarget(target: string): boolean {
  const reserved = [path.dirname(NVX_GUEST_RUN_SCRIPT), NVX_GUEST_RUN_SCRIPT];
  return reserved.some((entry) => entry === target || isWithin(entry, target));
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

async function canonicalDirectory(entry: NvxDirectoryExport): Promise<string> {
  if (!path.isAbsolute(entry.source)) {
    throw new Error(
      `NVX ${entry.tag} export source must be an absolute path: ${entry.source}`,
    );
  }
  const canonical = await fs.realpath(entry.source);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) {
    throw new Error(`NVX ${entry.tag} export source must be a directory: ${entry.source}`);
  }
  return canonical;
}
