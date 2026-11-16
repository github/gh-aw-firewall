import { StringDecoder } from 'string_decoder';
import { Transform, TransformCallback } from 'stream';

const MAX_PENDING_CHARS = 32 * 1024;
const OVERLAP_CHARS = 8 * 1024;

const CREDENTIAL_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|GITHUB_TOKEN)\s*[:=]\s*\S+/g,
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
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private reported = false;

  constructor(private readonly onCredentialDetected: () => void) {
    super();
  }

  private sanitize(value: string): string {
    const result = redactCredentials(value);
    if (result.detected && !this.reported) {
      this.reported = true;
      this.onCredentialDetected();
    }
    return result.output;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    if (Buffer.isBuffer(chunk) && !Buffer.from(chunk.toString('utf8')).equals(chunk)) {
      if (this.pending) {
        this.push(this.sanitize(this.pending));
        this.pending = '';
      }
      this.push(chunk);
      callback();
      return;
    }
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);

    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.pending.slice(0, newlineIndex + 1);
      this.pending = this.pending.slice(newlineIndex + 1);
      this.push(this.sanitize(line));
      newlineIndex = this.pending.indexOf('\n');
    }

    if (this.pending.length > MAX_PENDING_CHARS) {
      const emitLength = this.pending.length - OVERLAP_CHARS;
      const sanitized = this.sanitize(this.pending);
      this.push(sanitized.slice(0, emitLength));
      this.pending = this.pending.slice(emitLength);
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.end();
    if (this.pending) {
      this.push(this.sanitize(this.pending));
      this.pending = '';
    }
    callback();
  }
}
