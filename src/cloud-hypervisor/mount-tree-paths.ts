import * as path from 'path';

export function assertCleanAbsolutePath(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === '/' ||
    value.endsWith('/') ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 4096
  ) {
    throw new Error(`Cloud Hypervisor ${label} must be an absolute clean non-root path: ${value}`);
  }
}

export function assertContainedPath(parent: string, child: string, label: string): void {
  if (!containsPath(parent, child)) {
    throw new Error(`Cloud Hypervisor ${label} must stay inside ${parent}: ${child}`);
  }
}

export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function containsOrEquals(left: string, right: string): boolean {
  return left === right || containsPath(left, right) || containsPath(right, left);
}

export function assertNoOverlap(existing: readonly string[], candidate: string, label: string): void {
  for (const other of existing) {
    if (other === candidate) {
      throw new Error(`Duplicate ${label} destination: ${candidate}`);
    }
    if (containsPath(other, candidate) || containsPath(candidate, other)) {
      throw new Error(`Overlapping ${label} destinations: ${other} and ${candidate}`);
    }
  }
}

export function stagedPathFor(rootPath: string, source: string, destination: string): string {
  return path.join(rootPath, path.relative(source, destination));
}

export function pathDepth(value: string): number {
  return value.split(path.sep).length;
}
