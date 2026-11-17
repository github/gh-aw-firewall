import { Writable } from 'stream';

const MAX_STDERR_BYTES = 16 * 1024;

/** Retains complete lines only, dropping oversized lines and the oldest records. */
export class HostEnclaveStderr extends Writable {
  private readonly lines: Buffer[] = [];
  private bytes = 0;
  private pending = Buffer.alloc(0);
  private discarding = false;

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.discarding) {
        if (newline < 0) break;
        this.discarding = false;
        offset = newline + 1;
        continue;
      }
      if (this.pending.length + segment.length + 1 > MAX_STDERR_BYTES) {
        this.pending = Buffer.alloc(0);
        if (newline < 0) {
          this.discarding = true;
          break;
        }
        offset = newline + 1;
        continue;
      }
      this.pending = Buffer.concat([this.pending, segment]);
      if (newline < 0) break;
      const record = Buffer.concat([this.pending, Buffer.from('\n')]);
      this.lines.push(record);
      this.bytes += record.length;
      while (this.bytes > MAX_STDERR_BYTES) this.bytes -= this.lines.shift()!.length;
      this.pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    callback();
  }

  captured(): Buffer {
    return Buffer.concat(this.lines);
  }
}
