import { promises as fs } from 'fs';
import * as path from 'path';

export type CloudHypervisorExportMode = 'ro' | 'rw';

export interface CloudHypervisorDirectoryExport {
  readonly tag: string;
  readonly source: string;
  readonly target: string;
  readonly mode: CloudHypervisorExportMode;
}

export interface CloudHypervisorExportEnvironment {
  readonly GITHUB_WORKSPACE?: string;
  readonly RUNNER_TOOL_CACHE?: string;
  readonly AGENT_TOOLSDIRECTORY?: string;
  readonly RUNNER_TEMP?: string;
}

const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/;
const MAX_EXPORTS = 4;

export async function resolveCloudHypervisorExports(
  environment: CloudHypervisorExportEnvironment = process.env,
  cwd = process.cwd(),
): Promise<CloudHypervisorDirectoryExport[]> {
  const workspace = environment.GITHUB_WORKSPACE || cwd;
  const candidates: Array<CloudHypervisorDirectoryExport & { required: boolean }> = [
    { tag: 'workspace', source: workspace, target: '/workspace', mode: 'rw', required: true },
  ];
  const toolCache = environment.RUNNER_TOOL_CACHE || environment.AGENT_TOOLSDIRECTORY;
  if (toolCache) {
    candidates.push({
      tag: 'runner-tool-cache',
      source: toolCache,
      target: toolCache,
      mode: 'ro',
      required: false,
    });
  }
  if (environment.RUNNER_TEMP) {
    candidates.push({
      tag: 'runner-temp-gh-aw',
      source: path.join(environment.RUNNER_TEMP, 'gh-aw'),
      target: path.join(environment.RUNNER_TEMP, 'gh-aw'),
      mode: 'ro',
      required: false,
    });
  }
  candidates.push({
    tag: 'tmp-gh-aw',
    source: '/tmp/gh-aw',
    target: '/tmp/gh-aw',
    mode: 'rw',
    required: false,
  });

  const exports: CloudHypervisorDirectoryExport[] = [];
  const seenExports = new Map<string, number>();
  for (const candidate of candidates) {
    let resolved: string;
    try {
      resolved = await fs.realpath(candidate.source);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch (error) {
      if (!candidate.required && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `${candidate.required ? 'Cloud Hypervisor workspace' : `Cloud Hypervisor export "${candidate.tag}"`} ` +
        `must be an existing real directory: ${candidate.source}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const key = `${resolved}\0${candidate.target}`;
    const duplicateIndex = seenExports.get(key);
    const resolvedExport = {
      tag: candidate.tag,
      source: resolved,
      target: candidate.target,
      mode: candidate.mode,
    };
    if (duplicateIndex !== undefined) {
      if (candidate.mode === 'rw') exports[duplicateIndex] = resolvedExport;
      continue;
    }
    seenExports.set(key, exports.length);
    exports.push(resolvedExport);
  }
  return validateCloudHypervisorExports(exports);
}

export function validateCloudHypervisorExports(
  exports: readonly CloudHypervisorDirectoryExport[],
): CloudHypervisorDirectoryExport[] {
  if (exports.length === 0 || exports.length > MAX_EXPORTS) {
    throw new Error(`Cloud Hypervisor requires 1-${MAX_EXPORTS} directory exports`);
  }
  const tags = new Set<string>();
  const targets = new Set<string>();
  let workspace = false;
  const validated = exports.map((entry) => {
    if (!SAFE_TAG.test(entry.tag)) {
      throw new Error(`Unsafe Cloud Hypervisor export tag: ${entry.tag}`);
    }
    if (tags.has(entry.tag)) throw new Error(`Duplicate Cloud Hypervisor export tag: ${entry.tag}`);
    tags.add(entry.tag);
    assertCleanAbsoluteDirectoryPath(entry.source, `export "${entry.tag}" source`);
    assertCleanAbsoluteDirectoryPath(entry.target, `export "${entry.tag}" target`);
    if (isUnsafeGuestTarget(entry.target)) {
      throw new Error(`Unsafe Cloud Hypervisor export target: ${entry.target}`);
    }
    if (entry.mode !== 'ro' && entry.mode !== 'rw') {
      throw new Error(`Invalid Cloud Hypervisor export mode for "${entry.tag}": ${entry.mode}`);
    }
    if (targets.has(entry.target)) {
      throw new Error(`Duplicate Cloud Hypervisor export target: ${entry.target}`);
    }
    for (const target of targets) {
      if (containsPath(target, entry.target) || containsPath(entry.target, target)) {
        throw new Error(`Overlapping Cloud Hypervisor export targets: ${target} and ${entry.target}`);
      }
    }
    targets.add(entry.target);
    if (entry.tag === 'workspace') {
      workspace = entry.target === '/workspace' && entry.mode === 'rw';
    }
    return { ...entry };
  });
  if (!workspace) {
    throw new Error('Cloud Hypervisor requires read-write tag "workspace" at /workspace');
  }
  return validated;
}

function assertCleanAbsoluteDirectoryPath(value: string, label: string): void {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === '/' ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 4096
  ) {
    throw new Error(`Cloud Hypervisor ${label} must be an absolute clean non-root path: ${value}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function isUnsafeGuestTarget(target: string): boolean {
  return ['/boot', '/dev', '/etc', '/proc', '/run', '/sys', '/usr']
    .some((protectedPath) => target === protectedPath || containsPath(protectedPath, target));
}
