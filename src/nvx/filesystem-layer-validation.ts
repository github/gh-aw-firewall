import { promises as fs } from 'fs';
import * as path from 'path';
import type { NvxLayerSource } from './filesystem-builder';

const MIB = 1024 * 1024;
export const NVX_BLOCK_BYTES = 4096;
export const NVX_MIN_SCRATCH_BYTES = 128 * MIB;
export const NVX_DEFAULT_MAX_SCRATCH_BYTES = 8 * 1024 * MIB;
export const NVX_LAYER_ROLES = ['distro', 'runtime', 'custom'] as const;
export type NvxLayerRole = typeof NVX_LAYER_ROLES[number];

export function normalizeScratchBytes(
  requestedBytes: number,
  maximumBytes = NVX_DEFAULT_MAX_SCRATCH_BYTES,
): number {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < NVX_MIN_SCRATCH_BYTES
  ) {
    throw new Error(
      `NVX scratch cap must be at least ${NVX_MIN_SCRATCH_BYTES} bytes`,
    );
  }
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    throw new Error(`Invalid NVX scratch size: ${requestedBytes}`);
  }
  const normalized = Math.max(NVX_MIN_SCRATCH_BYTES, requestedBytes);
  const aligned = Math.ceil(normalized / NVX_BLOCK_BYTES) * NVX_BLOCK_BYTES;
  if (aligned > maximumBytes) {
    throw new Error(`NVX scratch requires ${aligned} bytes, exceeding cap ${maximumBytes}`);
  }
  return aligned;
}

export function normalizeNvxLayerSymlinkTarget(
  relativePath: string,
  target: string,
): string {
  if (!path.posix.isAbsolute(target)) return target;
  const guestTarget = path.posix.normalize(target);
  const guestDirectory = path.posix.dirname(`/${relativePath}`);
  return path.posix.relative(guestDirectory, guestTarget) || '.';
}

export function assertLayerSources(sources: readonly NvxLayerSource[]): void {
  if (sources.length < 1 || sources.length > NVX_LAYER_ROLES.length) {
    throw new Error('NVX requires one to three deterministic EROFS layer sources');
  }
  const roles = sources.map(({ role }) => role);
  for (const role of roles) {
    if (!NVX_LAYER_ROLES.includes(role)) {
      throw new Error(`Unsupported NVX layer role: ${String(role)}`);
    }
  }
  const duplicates = roles.filter((role, index) => roles.indexOf(role) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate NVX layer role: ${duplicates[0]}`);
  }
  if (!roles.includes('distro')) {
    throw new Error('NVX requires a distro source for its single immutable guest root');
  }
}

export function normalizeExcludedPaths(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    if (
      !value ||
      path.isAbsolute(value) ||
      value.includes('\0')
    ) {
      throw new Error(`NVX excluded path must be a non-empty relative path: ${value}`);
    }
    const relative = normalizeRelative(path.normalize(value));
    if (relative === '..' || relative.startsWith('../')) {
      throw new Error(`NVX excluded path escapes its layer source: ${value}`);
    }
    normalized.add(relative.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return [...normalized].sort();
}

export function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`);
  }
}

export function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/');
}

export function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) {
    throw new Error(`Unsafe NVX run id: ${runId}`);
  }
}

export function assertSourceDateEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid NVX SOURCE_DATE_EPOCH value: ${value}`);
  }
}

export function assertNonRootIdentity(uid: number, gid: number): void {
  if (
    !Number.isInteger(uid) ||
    !Number.isInteger(gid) ||
    uid < 1 ||
    gid < 1 ||
    uid > 0xffff_ffff ||
    gid > 0xffff_ffff
  ) {
    throw new Error(`NVX scratch identity must be a non-root UID:GID: ${uid}:${gid}`);
  }
}

export function assertUuid(value: string, label: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${label} must be a canonical lowercase UUID: ${value}`);
  }
}

export async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}
