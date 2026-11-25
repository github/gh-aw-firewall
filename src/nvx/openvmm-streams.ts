import type { Readable, Writable } from 'stream';

const OPENVMM_REPL_PROMPT = Buffer.from('openvmm> ');

export async function pump(
  source: Readable | null,
  destination: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  if (!source) return;
  for await (const chunk of source) {
    await destination(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

export function createOpenvmmStdoutGate(
  source: Readable | null,
  destination: (chunk: Buffer) => Promise<void>,
): {
  readonly completed: Promise<void>;
  arm(): void;
  waitForPrompt(timeoutMs: number): Promise<void>;
} {
  if (!source) throw new Error('OpenVMM stdout pipe is unavailable');
  let armed = false;
  let foundPrompt = false;
  let pending = Buffer.alloc(0);
  let resolvePrompt: (() => void) | undefined;
  let rejectPrompt: ((error: Error) => void) | undefined;
  const prompt = new Promise<void>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  void prompt.catch(() => undefined);
  const completed = (async () => {
    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!armed || foundPrompt) {
          await destination(buffer);
          continue;
        }
        pending = Buffer.concat([pending, buffer]);
        const promptIndex = pending.indexOf(OPENVMM_REPL_PROMPT);
        if (promptIndex >= 0) {
          const before = pending.subarray(0, promptIndex);
          const after = pending.subarray(promptIndex + OPENVMM_REPL_PROMPT.length);
          pending = Buffer.alloc(0);
          foundPrompt = true;
          if (before.length > 0) await destination(before);
          if (after.length > 0) await destination(after);
          resolvePrompt?.();
          continue;
        }
        const safeLength = Math.max(0, pending.length - OPENVMM_REPL_PROMPT.length + 1);
        if (safeLength > 0) {
          await destination(pending.subarray(0, safeLength));
          pending = pending.subarray(safeLength);
        }
      }
      if (pending.length > 0) await destination(pending);
      if (armed && !foundPrompt) {
        rejectPrompt?.(new Error('OpenVMM stdout closed before the REPL prompt'));
      }
    } catch (error) {
      rejectPrompt?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();
  return {
    completed,
    arm: () => {
      if (armed) throw new Error('OpenVMM REPL prompt gate is already armed');
      armed = true;
    },
    waitForPrompt: async (timeoutMs) => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          prompt,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Timed out waiting for the OpenVMM REPL prompt')),
              timeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}

export function writeStream(stream: Writable, contents: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(contents, (error) => error ? reject(error) : resolve());
  });
}

export function endStream(stream: Writable, contents: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(contents, (error?: Error | null) => error ? reject(error) : resolve());
  });
}
