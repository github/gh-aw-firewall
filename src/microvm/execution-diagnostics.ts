import type { GuestProtocolErrorCode, GuestProtocolFrame } from './guest-protocol';

export type GuestExecutionFailureReason =
  | 'guest-disconnected' | 'guest-socket-error' | 'guest-read-timeout'
  | 'guest-write-timeout' | 'guest-not-writable' | 'guest-output-failed'
  | 'guest-protocol-error' | 'guest-rejected';

const GUEST_REJECTION_PREFIXES = [
  ['resolve workspace mount:', 'workspace-resolution'],
  ['resolve cwd:', 'cwd-resolution'],
  ['cwd must ', 'cwd-validation'],
  ['cwd is not a directory', 'cwd-validation'],
  ['command not found in PATH:', 'command-resolution'],
  ['argv[0] must be absolute', 'command-resolution'],
  ['fork/exec ', 'process-start'],
  ['enclave uid and gid must match', 'identity-validation'],
  ['uid and gid must fit', 'identity-validation'],
  ['timeoutMs exceeds maximum', 'timeout-validation'],
  ['another command is already running', 'request-in-progress'],
  ['execution failed:', 'process-wait'],
] as const;

type GuestRejectionStage = (typeof GUEST_REJECTION_PREFIXES)[number][1] | 'unknown';

export function classifyGuestRejection(message: string): GuestRejectionStage {
  return GUEST_REJECTION_PREFIXES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? 'unknown';
}

export class GuestTransportError extends Error {
  constructor(
    readonly reason: GuestExecutionFailureReason,
    message: string = reason,
    readonly socketCode?: 'ECONNRESET' | 'ECONNREFUSED' | 'EPIPE' | 'ETIMEDOUT' | 'ENOENT' | 'EACCES',
  ) {
    super(message);
    this.name = 'GuestTransportError';
  }
}

/** Host-local metadata only: never includes request IDs, commands, environment or stream contents. */
export interface GuestExecutionDiagnostics {
  phase: 'sending' | 'sent' | 'first-response' | 'result' | 'failed' | 'host-timeout' | 'cancel';
  elapsedMs: number;
  framesReceived: number;
  stdoutBytes: number;
  stderrBytes: number;
  pendingFrameBytes: number;
  resultReceived: boolean;
  lastFrameType?: GuestProtocolFrame['type'];
  firstResponseMs?: number;
  sendCompletedMs?: number;
  failureReason?: GuestExecutionFailureReason;
  protocolCode?: GuestProtocolErrorCode;
  rejectionStage?: GuestRejectionStage;
  socketCode?: GuestTransportError['socketCode'];
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
}
