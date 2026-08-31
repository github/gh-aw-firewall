const BLOCKED_COMMAND_PREFIX = Buffer.from('[awf blocked workflow command] ', 'ascii');
const NEUTRALIZED_COMMAND_START = Buffer.from(': :', 'ascii');
const NEUTRALIZED_LEGACY_COMMAND_START = Buffer.from('# #[', 'ascii');

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0b || byte === 0x0c || byte === 0x20;
}

function isUnicodeWhitespaceLead(byte: number): boolean {
  return byte === 0xc2 || byte === 0xe1 || byte === 0xe2 || byte === 0xe3;
}

function unicodeWhitespaceStatus(
  bytes: readonly number[],
): 'pending' | 'whitespace' | 'invalid' {
  const [first, second, third] = bytes;
  if (first === 0xc2) {
    if (bytes.length === 1) return 'pending';
    return second === 0x85 || second === 0xa0 ? 'whitespace' : 'invalid';
  }
  if (first === 0xe1) {
    if (bytes.length === 1) return 'pending';
    if (second !== 0x9a) return 'invalid';
    if (bytes.length === 2) return 'pending';
    return third === 0x80 ? 'whitespace' : 'invalid';
  }
  if (first === 0xe2) {
    if (bytes.length === 1) return 'pending';
    if (second !== 0x80 && second !== 0x81) return 'invalid';
    if (bytes.length === 2) return 'pending';
    if (second === 0x80) {
      return (
        (third !== undefined && third >= 0x80 && third <= 0x8a) ||
        third === 0xa8 ||
        third === 0xa9 ||
        third === 0xaf
      ) ? 'whitespace' : 'invalid';
    }
    return third === 0x9f ? 'whitespace' : 'invalid';
  }
  if (first === 0xe3) {
    if (bytes.length === 1) return 'pending';
    if (second !== 0x80) return 'invalid';
    if (bytes.length === 2) return 'pending';
    return third === 0x80 ? 'whitespace' : 'invalid';
  }
  return 'invalid';
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

/**
 * Neutralizes GitHub Actions workflow commands in an untrusted byte stream.
 * It buffers at most four candidate bytes, so arbitrary chunks and long lines
 * do not require decoding or line-sized buffering.
 */
export class WorkflowCommandFilter {
  private lineCanStartCommand = true;
  private candidateColons = 0;
  private legacyCandidate: number[] = [];
  private unicodeWhitespaceCandidate: number[] = [];

  push(data: Buffer): Buffer {
    const output: number[] = [];

    for (const byte of data) {
      this.processByte(byte, output);
    }

    return Buffer.from(output);
  }

  finish(): Buffer {
    const trailing = Buffer.from([
      ...this.unicodeWhitespaceCandidate,
      ...Array<number>(this.candidateColons).fill(0x3a),
      ...this.legacyCandidate,
    ]);
    this.unicodeWhitespaceCandidate = [];
    this.candidateColons = 0;
    this.legacyCandidate = [];
    return trailing;
  }

  private processByte(byte: number, output: number[]): void {
    if (this.legacyCandidate.length === 1) {
      if (byte === 0x23) {
        this.legacyCandidate.push(byte);
        return;
      }
      this.processV2Byte(0x23, output);
      this.legacyCandidate = [];
    } else if (this.legacyCandidate.length === 2) {
      this.legacyCandidate = [];
      if (byte === 0x5b) {
        this.flushV2Candidate(output);
        output.push(...BLOCKED_COMMAND_PREFIX, ...NEUTRALIZED_LEGACY_COMMAND_START);
        this.lineCanStartCommand = false;
        return;
      }
      this.processV2Byte(0x23, output);
      this.processV2Byte(0x23, output);
    }

    if (byte === 0x23) {
      this.legacyCandidate.push(byte);
      return;
    }
    this.processV2Byte(byte, output);
  }

  private flushV2Candidate(output: number[]): void {
    if (this.unicodeWhitespaceCandidate.length > 0) {
      output.push(...this.unicodeWhitespaceCandidate);
      this.unicodeWhitespaceCandidate = [];
    }
    if (this.candidateColons > 0) {
      output.push(...Array<number>(this.candidateColons).fill(0x3a));
      this.candidateColons = 0;
    }
  }

  private processV2Byte(byte: number, output: number[]): void {
    if (this.unicodeWhitespaceCandidate.length > 0) {
      this.unicodeWhitespaceCandidate.push(byte);
      const status = unicodeWhitespaceStatus(this.unicodeWhitespaceCandidate);
      if (status === 'pending') return;
      const candidate = this.unicodeWhitespaceCandidate;
      this.unicodeWhitespaceCandidate = [];
      if (status === 'whitespace') {
        output.push(...candidate);
        return;
      }
      this.lineCanStartCommand = false;
      output.push(candidate[0]);
      for (const remaining of candidate.slice(1)) this.processByte(remaining, output);
      return;
    }

    if (this.candidateColons === 1) {
      if (byte === 0x3a) {
        this.candidateColons = 2;
        return;
      }
      output.push(0x3a);
      this.candidateColons = 0;
      this.lineCanStartCommand = false;
    } else if (this.candidateColons === 2) {
      this.candidateColons = 0;
      if (isAsciiLetter(byte)) {
        output.push(...BLOCKED_COMMAND_PREFIX, ...NEUTRALIZED_COMMAND_START, byte);
        this.lineCanStartCommand = false;
        return;
      }
      output.push(0x3a, 0x3a);
      this.lineCanStartCommand = false;
    }

    if (byte === 0x0a || byte === 0x0d) {
      output.push(byte);
      this.lineCanStartCommand = true;
      return;
    }
    if (this.lineCanStartCommand && isAsciiWhitespace(byte)) {
      output.push(byte);
      return;
    }
    if (this.lineCanStartCommand && isUnicodeWhitespaceLead(byte)) {
      this.unicodeWhitespaceCandidate.push(byte);
      return;
    }
    if (this.lineCanStartCommand && byte === 0x3a) {
      this.candidateColons = 1;
      return;
    }

    output.push(byte);
    this.lineCanStartCommand = false;
  }
}
