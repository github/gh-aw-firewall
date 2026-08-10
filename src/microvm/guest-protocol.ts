/**
 * AWF framed guest-supervisor protocol. Transport-independent: the same
 * length-prefixed JSON framing is used regardless of which VMM backend
 * (Firecracker today, others later) carries the bytes over vsock/UDS.
 */
export const GUEST_PROTOCOL_VERSION = 1 as const;
export const GUEST_MAX_FRAME_BYTES = 1024 * 1024;
export const GUEST_MAX_STREAM_CHUNK_BYTES = 64 * 1024;
export const GUEST_MAX_ENV_ENTRIES = 512;
export const GUEST_MAX_ARGV_ENTRIES = 4096;
export const GUEST_MAX_STRING_BYTES = 256 * 1024;

export type GuestProtocolErrorCode =
  | 'invalid_frame'
  | 'protocol_version_mismatch'
  | 'invalid_request'
  | 'request_in_progress'
  | 'request_not_found'
  | 'tty_unsupported'
  | 'internal_error';

interface ProtocolFrame {
  readonly version: typeof GUEST_PROTOCOL_VERSION;
  readonly type: string;
  readonly requestId: string;
}

export interface GuestReadyFrame extends ProtocolFrame {
  readonly type: 'ready';
  readonly capabilities: {
    readonly stdin: boolean;
    readonly tty: boolean;
    readonly resize: boolean;
  };
}

export interface GuestExecuteFrame extends ProtocolFrame {
  readonly type: 'execute';
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly uid: number;
  readonly gid: number;
  readonly tty: boolean;
  readonly timeoutMs?: number;
}

export interface GuestStreamFrame extends ProtocolFrame {
  readonly type: 'stdout' | 'stderr';
  readonly data: string;
}

export interface GuestStdinFrame extends ProtocolFrame {
  readonly type: 'stdin';
  readonly data?: string;
  readonly eof?: boolean;
}

export interface GuestResizeFrame extends ProtocolFrame {
  readonly type: 'resize';
  readonly columns: number;
  readonly rows: number;
}

export interface GuestCancelFrame extends ProtocolFrame {
  readonly type: 'cancel';
  readonly reason: string;
}

export interface GuestResultFrame extends ProtocolFrame {
  readonly type: 'result';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export interface GuestErrorFrame extends ProtocolFrame {
  readonly type: 'error';
  readonly code: GuestProtocolErrorCode;
  readonly message: string;
  readonly expectedVersion?: number;
}

export interface GuestShutdownFrame extends ProtocolFrame {
  readonly type: 'shutdown' | 'shutting_down';
}

export type GuestProtocolFrame =
  | GuestReadyFrame
  | GuestExecuteFrame
  | GuestStreamFrame
  | GuestStdinFrame
  | GuestResizeFrame
  | GuestCancelFrame
  | GuestResultFrame
  | GuestErrorFrame
  | GuestShutdownFrame;

export class GuestProtocolError extends Error {
  constructor(
    readonly code: GuestProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GuestProtocolError';
  }
}

export function encodeGuestFrame(frame: GuestProtocolFrame): Buffer {
  validateGuestFrame(frame);
  const payload = Buffer.from(JSON.stringify(frame), 'utf8');
  if (payload.length > GUEST_MAX_FRAME_BYTES) {
    throw new GuestProtocolError(
      'invalid_frame',
      `guest frame exceeds ${GUEST_MAX_FRAME_BYTES} bytes`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export class GuestFrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  get pendingBytes(): number {
    return this.buffered.length;
  }

  push(chunk: Buffer): GuestProtocolFrame[] {
    if (chunk.length === 0) return [];
    this.buffered = this.buffered.length === 0
      ? chunk
      : Buffer.concat([this.buffered, chunk]);
    const frames: GuestProtocolFrame[] = [];
    while (this.buffered.length >= 4) {
      const payloadLength = this.buffered.readUInt32BE(0);
      if (payloadLength === 0 || payloadLength > GUEST_MAX_FRAME_BYTES) {
        throw new GuestProtocolError(
          'invalid_frame',
          `Invalid guest frame length: ${payloadLength}`,
        );
      }
      if (this.buffered.length < payloadLength + 4) break;
      const payload = this.buffered.subarray(4, payloadLength + 4);
      this.buffered = this.buffered.subarray(payloadLength + 4);
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload.toString('utf8'));
      } catch (error) {
        throw new GuestProtocolError(
          'invalid_frame',
          `guest frame contains invalid JSON: ${formatError(error)}`,
        );
      }
      validateGuestFrame(decoded);
      frames.push(decoded);
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.length !== 0) {
      throw new GuestProtocolError(
        'invalid_frame',
        `guest connection ended with ${this.buffered.length} incomplete frame bytes`,
      );
    }
  }
}

export function validateGuestFrame(value: unknown): asserts value is GuestProtocolFrame {
  const frame = asRecord(value, 'frame');
  const version = frame.version;
  if (version !== GUEST_PROTOCOL_VERSION) {
    throw new GuestProtocolError(
      'protocol_version_mismatch',
      `Unsupported guest protocol version ${String(version)}; ` +
      `expected ${GUEST_PROTOCOL_VERSION}`,
    );
  }
  const type = requiredString(frame.type, 'type', 64);
  requiredRequestId(frame.requestId);
  switch (type) {
    case 'ready': {
      assertKeys(frame, ['version', 'type', 'requestId', 'capabilities']);
      const capabilities = asRecord(frame.capabilities, 'capabilities');
      assertKeys(capabilities, ['stdin', 'tty', 'resize']);
      requiredBoolean(capabilities.stdin, 'capabilities.stdin');
      requiredBoolean(capabilities.tty, 'capabilities.tty');
      requiredBoolean(capabilities.resize, 'capabilities.resize');
      return;
    }
    case 'execute': {
      assertKeys(frame, [
        'version', 'type', 'requestId', 'argv', 'env', 'cwd', 'uid', 'gid', 'tty', 'timeoutMs',
      ]);
      if (
        !Array.isArray(frame.argv) ||
        frame.argv.length === 0 ||
        frame.argv.length > GUEST_MAX_ARGV_ENTRIES
      ) {
        invalid(`argv must contain 1-${GUEST_MAX_ARGV_ENTRIES} strings`);
      }
      for (const [index, arg] of frame.argv.entries()) {
        requiredString(arg, `argv[${index}]`, GUEST_MAX_STRING_BYTES);
      }
      const env = asRecord(frame.env, 'env');
      const entries = Object.entries(env);
      if (entries.length > GUEST_MAX_ENV_ENTRIES) {
        invalid(`env exceeds ${GUEST_MAX_ENV_ENTRIES} entries`);
      }
      for (const [name, envValue] of entries) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 256) {
          invalid(`Invalid environment variable name: ${name}`);
        }
        requiredString(envValue, `env.${name}`, GUEST_MAX_STRING_BYTES, true);
      }
      const cwd = requiredString(frame.cwd, 'cwd', 4096);
      if (!cwd.startsWith('/') || cwd.includes('\0')) invalid('cwd must be an absolute path');
      positiveInteger(frame.uid, 'uid');
      positiveInteger(frame.gid, 'gid');
      requiredBoolean(frame.tty, 'tty');
      if (frame.timeoutMs !== undefined) positiveInteger(frame.timeoutMs, 'timeoutMs');
      return;
    }
    case 'stdout':
    case 'stderr': {
      assertKeys(frame, ['version', 'type', 'requestId', 'data']);
      const data = requiredString(
        frame.data,
        'data',
        Math.ceil(GUEST_MAX_STREAM_CHUNK_BYTES * 4 / 3) + 4,
        true,
      );
      validateBase64Chunk(data);
      return;
    }
    case 'stdin': {
      assertKeys(frame, ['version', 'type', 'requestId', 'data', 'eof']);
      if (frame.data === undefined && frame.eof !== true) {
        invalid('stdin requires data or eof=true');
      }
      if (frame.data !== undefined) {
        validateBase64Chunk(requiredString(
          frame.data,
          'data',
          Math.ceil(GUEST_MAX_STREAM_CHUNK_BYTES * 4 / 3) + 4,
          true,
        ));
      }
      if (frame.eof !== undefined) requiredBoolean(frame.eof, 'eof');
      return;
    }
    case 'resize':
      assertKeys(frame, ['version', 'type', 'requestId', 'columns', 'rows']);
      boundedInteger(frame.columns, 'columns', 1, 65_535);
      boundedInteger(frame.rows, 'rows', 1, 65_535);
      return;
    case 'cancel':
      assertKeys(frame, ['version', 'type', 'requestId', 'reason']);
      requiredString(frame.reason, 'reason', 4096);
      return;
    case 'result':
      assertKeys(frame, [
        'version', 'type', 'requestId', 'exitCode', 'signal', 'timedOut',
      ]);
      if (frame.exitCode !== null) boundedInteger(frame.exitCode, 'exitCode', 0, 255);
      if (frame.signal !== null) requiredString(frame.signal, 'signal', 64);
      if ((frame.exitCode === null) === (frame.signal === null)) {
        invalid('result must contain exactly one of exitCode or signal');
      }
      requiredBoolean(frame.timedOut, 'timedOut');
      return;
    case 'error':
      assertKeys(frame, [
        'version', 'type', 'requestId', 'code', 'message', 'expectedVersion',
      ]);
      if (![
        'invalid_frame',
        'protocol_version_mismatch',
        'invalid_request',
        'request_in_progress',
        'request_not_found',
        'tty_unsupported',
        'internal_error',
      ].includes(String(frame.code))) {
        invalid(`Unknown error code: ${String(frame.code)}`);
      }
      requiredString(frame.message, 'message', 16 * 1024);
      if (frame.expectedVersion !== undefined) {
        positiveInteger(frame.expectedVersion, 'expectedVersion');
      }
      return;
    case 'shutdown':
    case 'shutting_down':
      assertKeys(frame, ['version', 'type', 'requestId']);
      return;
    default:
      invalid(`Unknown guest frame type: ${type}`);
  }
}

function validateBase64Chunk(value: string): void {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalid('stream data must be canonical base64');
  }
  if (Buffer.byteLength(value, 'base64') > GUEST_MAX_STREAM_CHUNK_BYTES) {
    invalid(`decoded stream data exceeds ${GUEST_MAX_STREAM_CHUNK_BYTES} bytes`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) invalid(`Unexpected frame property: ${key}`);
  }
}

function requiredRequestId(value: unknown): string {
  const requestId = requiredString(value, 'requestId', 128);
  if (!/^[A-Za-z0-9_.-]+$/.test(requestId)) invalid(`Invalid requestId: ${requestId}`);
  return requestId;
}

function requiredString(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    value.includes('\0')
  ) {
    invalid(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${maxBytes} bytes`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} must be an integer in ${minimum}-${maximum}`);
  }
  return value as number;
}

function invalid(message: string): never {
  throw new GuestProtocolError('invalid_request', message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
