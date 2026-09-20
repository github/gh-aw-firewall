import type { Writable } from 'stream';

export async function writeWithBackpressure(
  destination: Writable,
  data: Buffer,
): Promise<void> {
  if (data.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      destination.off('error', onError);
    };
    const onWrite = (error: Error | null | undefined): void => {
      if (error) {
        queueMicrotask(cleanup);
        reject(error);
      } else {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    destination.once('error', onError);
    destination.write(data, onWrite);
  });
}
