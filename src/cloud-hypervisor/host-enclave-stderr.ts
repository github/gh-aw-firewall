import { Writable } from 'stream';

const MAX_WRAPPER_STDERR_BYTES = 16 * 1024;

export function createHostEnclaveStderrCapture(): { stream: Writable; read(): Buffer } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let pendingLine = Buffer.alloc(0);
  let discardLine = false;
  const retainLine = (line: Buffer): void => {
    const record = Buffer.concat([line, Buffer.from('\n')]);
    if (record.length > MAX_WRAPPER_STDERR_BYTES) return;
    chunks.push(record);
    bytes += record.length;
    while (bytes > MAX_WRAPPER_STDERR_BYTES) {
      bytes -= chunks.shift()!.length;
    }
  };
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (discardLine) {
          if (newline < 0) break;
          discardLine = false;
          offset = newline + 1;
          continue;
        }
        if (pendingLine.length + segment.length + 1 > MAX_WRAPPER_STDERR_BYTES) {
          pendingLine = Buffer.alloc(0);
          if (newline < 0) {
            discardLine = true;
            break;
          }
          offset = newline + 1;
          continue;
        }
        pendingLine = Buffer.concat([pendingLine, segment]);
        if (newline < 0) break;
        retainLine(pendingLine);
        pendingLine = Buffer.alloc(0);
        offset = newline + 1;
      }
      callback();
    },
  });
  return { stream, read: () => Buffer.concat(chunks) };
}
