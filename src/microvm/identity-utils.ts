import { promises as fs } from 'fs';

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePositiveInteger(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Account returned an invalid ${label}: ${trimmed}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Account returned an unsafe ${label}: ${trimmed}`);
  }
  return parsed;
}

/**
 * Only ENOENT proves that a process is gone. Permission and I/O errors must
 * propagate so an unreadable live process never authorizes lock reclamation.
 */
export async function readProcessStartTime(
  pid: number,
  readFile: (filePath: string, encoding: 'utf8') => Promise<string> =
    (filePath, encoding) => fs.readFile(filePath, encoding),
): Promise<string | undefined> {
  try {
    return parseProcessStatStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function parseProcessStatStartTime(stat: string): string {
  const close = stat.lastIndexOf(')');
  const startTime = close === -1 ? undefined : stat.slice(close + 2).trim().split(/\s+/)[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error('Malformed process stat start time');
  }
  return startTime;
}
