export function guardStaleChildPipe(
  stream: NodeJS.ReadableStream,
  isIntentionalTermination: () => boolean,
): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (isIntentionalTermination() && error.code === 'ECONNRESET') {
      return;
    }
    throw error;
  });
}
