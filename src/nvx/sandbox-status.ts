import type { Readable } from 'stream';

const STATUS_MAX_BYTES = 64 * 1024;

export function readSandboxStatus(stream: Readable): {
  readonly pid: Promise<number>;
  readonly completed: Promise<void>;
} {
  let resolvePid: ((pid: number) => void) | undefined;
  let rejectPid: ((error: Error) => void) | undefined;
  const pid = new Promise<number>((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });
  void pid.catch(() => undefined);
  const completed = (async () => {
    let contents = Buffer.alloc(0);
    let totalBytes = 0;
    let foundPid = false;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > STATUS_MAX_BYTES) {
          throw new Error('Bubblewrap JSON status exceeded the bounded size limit');
        }
        if (foundPid) continue;
        contents = Buffer.concat([contents, buffer]);
        const newline = contents.indexOf(0x0a);
        if (newline < 0) continue;
        const status = parseSandboxStatus(contents.subarray(0, newline));
        foundPid = true;
        resolvePid?.(status);
      }
      if (!foundPid) {
        if (contents.length === 0) {
          throw new Error('Bubblewrap did not report JSON status');
        }
        resolvePid?.(parseSandboxStatus(contents));
      }
    } catch (error) {
      const parsed = error instanceof Error ? error : new Error(String(error));
      rejectPid?.(parsed);
      throw parsed;
    }
  })();
  void completed.catch(() => undefined);
  return { pid, completed };
}

function parseSandboxStatus(contents: Buffer): number {
  let status: unknown;
  try {
    status = JSON.parse(contents.toString('utf8').trim());
  } catch (error) {
    throw new Error(
      `Bubblewrap JSON status is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pid = (status as { ['child-pid']?: unknown })?.['child-pid'];
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new Error('Bubblewrap JSON status has no valid child-pid');
  }
  return pid as number;
}
