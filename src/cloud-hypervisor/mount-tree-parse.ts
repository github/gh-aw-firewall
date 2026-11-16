import type { MountTreeDependencies } from './mount-tree';
import { containsPath } from './mount-tree-paths';

export interface MountInfoEntry {
  readonly mountPoint: string;
  readonly options: readonly string[];
  readonly optionalFields: readonly string[];
}

export function parseMountInfo(contents: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(' ');
    const separator = fields.indexOf('-');
    if (fields.length < 7 || separator < 6) continue;
    entries.push({
      mountPoint: unescapeMountInfoPath(fields[4]),
      options: fields[5].split(','),
      optionalFields: fields.slice(6, separator),
    });
  }
  return entries;
}

export async function readExactMounts(
  dependencies: Pick<MountTreeDependencies, 'readMountInfo'>,
  target: string,
): Promise<MountInfoEntry[]> {
  return parseMountInfo(await dependencies.readMountInfo())
    .filter((entry) => entry.mountPoint === target);
}

export async function readTreeMountInfo(
  dependencies: Pick<MountTreeDependencies, 'readMountInfo'>,
  rootPath: string,
): Promise<MountInfoEntry[]> {
  const entries = parseMountInfo(await dependencies.readMountInfo());
  return entries.filter(
    (entry) => entry.mountPoint === rootPath || containsPath(rootPath, entry.mountPoint),
  );
}

function unescapeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, code: string) =>
    String.fromCharCode(parseInt(code, 8)),
  );
}
