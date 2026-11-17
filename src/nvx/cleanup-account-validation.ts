import type { promises as fs } from 'fs';

export function validatePendingAccountPasswd(
  contents: string,
  name: string,
  runId: string,
): { uid: number; gid: number } {
  const fields = contents.trim().split(':');
  if (
    fields.length !== 7 ||
    fields[0] !== name ||
    !/^\d+$/.test(fields[2]) ||
    !/^\d+$/.test(fields[3]) ||
    fields[4] !== `AWF NVX ${runId}` ||
    fields[5] !== '/nonexistent' ||
    fields[6] !== '/usr/sbin/nologin'
  ) {
    throw new Error(`Refusing to remove unverified pending NVX account ${name}`);
  }
  return { uid: Number(fields[2]), gid: Number(fields[3]) };
}

export function validatePendingAccountGroup(
  contents: string,
  name: string,
  expectedGid: number | undefined,
): void {
  const fields = contents.trim().split(':');
  if (
    fields.length !== 4 ||
    fields[0] !== name ||
    !/^\d+$/.test(fields[2]) ||
    fields[3] !== '' ||
    expectedGid === undefined ||
    Number(fields[2]) !== expectedGid
  ) {
    throw new Error(`Refusing to remove unverified pending NVX group ${name}`);
  }
}

export async function exists(filePath: string, lstat: typeof fs.lstat): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
