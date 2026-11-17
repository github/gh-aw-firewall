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
 * ENOENT and ESRCH indicate that a process is gone; ESRCH can occur when a
 * task is reaped between opening and reading its stat record. Permission,
 * I/O, and malformed-record errors must propagate to keep reclamation safe.
 */
export async function readProcessStartTime(
  pid: number,
  readFile: (filePath: string, encoding: 'utf8') => Promise<string> =
    (filePath, encoding) => fs.readFile(filePath, encoding),
): Promise<string | undefined> {
  try {
    return parseProcessStatStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
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
