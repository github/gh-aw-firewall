import * as path from 'path';

export function assertIdentity(
  fields: readonly number[],
  expected: number,
  label: string,
  taskId: number,
): void {
  if (fields.length !== 4 || fields.some((field) => field !== expected)) {
    throw new Error(`NVX OpenVMM thread ${taskId} has unexpected ${label}`);
  }
}

export function assertSafeName(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Unsafe ${label} name: ${value}`);
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function assertAbsolutePath(value: string, label: string): void {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} path must be absolute`);
  }
}

export function assertRunScopedPath(
  value: string,
  root: string,
  basenamePattern: RegExp,
  label: string,
): string {
  assertAbsolutePath(value, label);
  const resolved = path.resolve(value);
  if (path.dirname(resolved) !== root || !basenamePattern.test(path.basename(resolved))) {
    throw new Error(`${label} must be an AWF-owned per-run path under ${root}`);
  }
  return resolved;
}

export function assertNonOverlappingPaths(left: string, right: string): void {
  if (left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)) {
    throw new Error('NVX trusted artifact root and run directory must not overlap');
  }
}
