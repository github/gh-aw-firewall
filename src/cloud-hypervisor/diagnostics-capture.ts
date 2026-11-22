import { constants, promises as fs } from 'fs';
import { Writable } from 'stream';
import {
  CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES,
  type CloudHypervisorIdentity,
  type CloudHypervisorManagerDependencies,
} from './manager-types';
import { redactPublicEnclaveText } from '../enclave/public-debug-redaction';
import { writeAuditFile } from './diagnostics-paths';

/** Reads at most `maxBytes` from the end of `filePath`. */
export async function readBoundedTail(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe diagnostic source file');
    const { size } = stat;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(buffer, 0, length, size - length);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Retains only the trailing `maximumBytes` of an unbounded output stream. */
export class BoundedOutputCapture {
  private buffer = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, next]);
    if (this.buffer.length > this.maximumBytes) {
      this.truncated = true;
      this.buffer = this.buffer.subarray(this.buffer.length - this.maximumBytes);
    }
  }

  contents(): Buffer {
    return this.buffer;
  }

  /** Public retention cannot disclose a partial credential at a tail boundary. */
  publicContents(): Buffer {
    if (!this.truncated) return this.buffer;
    const newline = this.buffer.indexOf(10);
    return newline < 0 ? Buffer.alloc(0) : this.buffer.subarray(newline + 1);
  }

  writable(): Writable {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.append(chunk);
        callback();
      },
    });
  }
}

export async function copyBoundedDiagnostic(
  dependencies: CloudHypervisorManagerDependencies,
  source: string,
  destination: string,
  identity: CloudHypervisorIdentity,
  secrets?: readonly string[],
): Promise<void> {
  let bounded: Buffer;
  try {
    bounded = await dependencies.readFileTail(source, CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  if (secrets && bounded.length === CLOUD_HYPERVISOR_CAPTURE_LIMIT_BYTES) {
    const newline = bounded.indexOf(10);
    bounded = newline < 0 ? Buffer.alloc(0) : bounded.subarray(newline + 1);
  }
  await writeAuditFile(dependencies, destination,
    secrets ? redactPublicEnclaveText(bounded, secrets) : bounded, identity);
}
