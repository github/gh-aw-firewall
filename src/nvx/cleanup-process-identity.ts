import { promises as fs } from 'fs';
import type { NvxCleanupProcessIdentity } from './cleanup-record';

export async function captureProcessIdentity(
  pid: number,
  dependencies: Pick<typeof fs, 'readFile' | 'readlink' | 'stat'> = {
    readFile: fs.readFile,
    readlink: fs.readlink,
    stat: fs.stat,
  },
): Promise<NvxCleanupProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Unsafe NVX process id: ${pid}`);
  const statText = await dependencies.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/);
  const status = await dependencies.readFile(`/proc/${pid}/status`, 'utf8');
  const executableLink = `/proc/${pid}/exe`;
  const executableStat = await dependencies.stat(executableLink, { bigint: true });
  return {
    pid,
    startTimeTicks: fields[19],
    executable: (await dependencies.readlink(executableLink)).replace(/ \(deleted\)$/, ''),
    executableDevice: executableStat.dev.toString(),
    executableInode: executableStat.ino.toString(),
    uid: parseStatusIdentity(status, 'Uid'),
    gid: parseStatusIdentity(status, 'Gid'),
    networkNamespace: await dependencies.readlink(`/proc/${pid}/ns/net`),
  };
}

export function parseStatusIdentity(status: string, field: 'Uid' | 'Gid'): number {
  const values = status.split(/\r?\n/)
    .find((line) => line.startsWith(`${field}:`))
    ?.slice(field.length + 1).trim().split(/\s+/);
  if (!values || values.length !== 4 || values.some((value) => value !== values[0])) {
    throw new Error(`NVX process ${field} identities are unstable`);
  }
  return Number(values[0]);
}

export function sameProcess(
  left: NvxCleanupProcessIdentity,
  right: NvxCleanupProcessIdentity,
): boolean {
  return left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks &&
    left.executable === right.executable &&
    left.executableDevice === right.executableDevice &&
    left.executableInode === right.executableInode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.networkNamespace === right.networkNamespace;
}
