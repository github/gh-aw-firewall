import type { Writable } from 'stream';

export async function writeWithBackpressure(
  destination: Writable,
  data: Buffer,
): Promise<void> {
  if (data.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      destination.off('drain', onDrain);
      destination.off('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    destination.once('drain', onDrain);
    destination.once('error', onError);
    if (destination.write(data)) {
      cleanup();
      resolve();
    }
  });
}
