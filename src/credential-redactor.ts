import { Transform, TransformCallback } from 'stream';

const MAX_PENDING_CHARS = 32 * 1024;
const OVERLAP_CHARS = 8 * 1024;

const CREDENTIAL_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function fixedLengthMask(value: string): string {
  const marker = '[REDACTED_CREDENTIAL]';
  return (marker + '*'.repeat(Math.max(0, value.length - marker.length))).slice(0, value.length);
}

export function redactCredentials(value: string): { output: string; detected: boolean } {
  let detected = false;
  let output = value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (match) => {
      detected = true;
      return fixedLengthMask(match);
    });
  }
  return { output, detected };
}

export class CredentialRedactingStream extends Transform {
  private pending = Buffer.alloc(0);
  private reported = false;

  constructor(private readonly onCredentialDetected: () => void) {
    super();
  }

  private sanitize(value: Buffer): Buffer {
    const result = redactCredentials(value.toString('latin1'));
    if (result.detected && !this.reported) {
      this.reported = true;
      this.onCredentialDetected();
    }
    return Buffer.from(result.output, 'latin1');
  }

  private safeEmissionLength(emitLength: number): number {
    const value = this.pending.toString('latin1');
    let safeLength = emitLength;
    for (const pattern of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value)) !== null) {
        const matchEnd = match.index + match[0].length;
        if (match.index < safeLength && matchEnd > safeLength) {
          safeLength = match.index;
        }
      }
    }
    return safeLength;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending = Buffer.concat([
      this.pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
    ]);

    let newlineIndex = this.pending.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = this.pending.subarray(0, newlineIndex + 1);
      this.pending = this.pending.subarray(newlineIndex + 1);
      this.push(this.sanitize(line));
      newlineIndex = this.pending.indexOf(0x0a);
    }

    if (this.pending.length > MAX_PENDING_CHARS) {
      const emitLength = this.safeEmissionLength(this.pending.length - OVERLAP_CHARS);
      if (emitLength > 0) {
        this.push(this.sanitize(this.pending.subarray(0, emitLength)));
        this.pending = this.pending.subarray(emitLength);
      }
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.pending.length > 0) {
      this.push(this.sanitize(this.pending));
      this.pending = Buffer.alloc(0);
    }
    callback();
  }
}
