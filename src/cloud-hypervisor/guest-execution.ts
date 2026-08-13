import type { MicrovmVsockClient } from '../microvm/vsock-client';
import type {
  GuestExecutionRequest,
  GuestExecutionResult,
} from '../microvm/vsock-client';
import type { CloudHypervisorManagerDependencies } from './manager-types';

/**
 * Cloud Hypervisor's vsock-over-UDS multiplexer closes the host-facing
 * connection immediately (rather than blocking/retrying) if the guest
 * isn't yet listening on the target vsock port when a `CONNECT <port>`
 * handshake arrives — observed live as `startInstance()` failing with
 * "guest disconnected before readiness" even on a successful `vm.boot()`.
 * This is a real host/guest boot-timing race (kernel decompression +
 * supervisor startup take a variable, host-load-dependent amount of time),
 * not a fatal error, so the connect is retried with a fresh client and a
 * short backoff until the guest is actually ready or this budget elapses.
 *
 * The budget is deliberately generous (not a tight few-second timeout):
 * live validation on GitHub-hosted Ubuntu runners showed the guest kernel's
 * own internal clock advancing far slower than host wall-clock time during
 * early PCI/virtio device enumeration (e.g. ~9-20s of host wall-clock time
 * elapsing while the guest's own boot log timestamps were still under 1s)
 * — consistent with the extra scheduling overhead of nested virtualization
 * on these runners (Cloud Hypervisor itself logs running under a
 * "Microsoft Hv" nested hypervisor there). A short budget here would abort
 * a guest that is simply slow to be scheduled, not actually hung or
 * crashed. This matches the smoke test's own boot-readiness ceiling
 * (`BOOT_READINESS_CEILING_MS` in cloud-hypervisor-live-smoke.sh).
 */
const CLOUD_HYPERVISOR_GUEST_READY_RETRY_INTERVAL_MS = 250;
const CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS = 90_000;

const GUEST_BUSY_SHUTDOWN_MESSAGE = 'Cannot shut down guest while a request is running';

export interface GuestShutdownOutcome {
  acknowledged: boolean;
  error?: unknown;
}

/**
 * Connects to the guest supervisor over vsock, retrying on the
 * "guest disconnected before readiness" boot-timing race documented on
 * {@link CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS} above. Each attempt
 * uses a fresh client (MicrovmVsockClient does not support reconnecting
 * a socket that already closed).
 */
export async function connectGuestWithRetry(
  dependencies: CloudHypervisorManagerDependencies,
  vsockSocketPath: string,
  port: number,
  timeoutMs: number,
): Promise<MicrovmVsockClient> {
  const deadline = Date.now() + CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS;
  let lastError: unknown;
  do {
    const client = dependencies.createVsockClient(vsockSocketPath, port, timeoutMs);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      client.destroy();
      if (Date.now() >= deadline) break;
      await dependencies.sleep(CLOUD_HYPERVISOR_GUEST_READY_RETRY_INTERVAL_MS);
    }
  } while (Date.now() < deadline);
  throw lastError instanceof Error
    ? lastError
    : new Error('Cloud Hypervisor guest vsock connection failed');
}

/**
 * Owns the connected guest supervisor vsock client and the host-side
 * execution/IO surface (execute, cancel, stdin, terminal resize) layered
 * on top of it.
 */
export class CloudHypervisorGuestChannel {
  constructor(private readonly client: MicrovmVsockClient) {}

  static async connect(
    dependencies: CloudHypervisorManagerDependencies,
    vsockSocketPath: string,
    port: number,
    timeoutMs: number,
  ): Promise<CloudHypervisorGuestChannel> {
    return new CloudHypervisorGuestChannel(
      await connectGuestWithRetry(dependencies, vsockSocketPath, port, timeoutMs),
    );
  }

  execute(request: GuestExecutionRequest): Promise<GuestExecutionResult> {
    return this.client.execute(request);
  }

  cancel(reason: string, requestId?: string): Promise<void> {
    return this.client.cancel(reason, requestId);
  }

  writeStdin(data: Buffer, requestId?: string): Promise<void> {
    return this.client.writeStdin(data, requestId);
  }

  endStdin(requestId?: string): Promise<void> {
    return this.client.endStdin(requestId);
  }

  resize(columns: number, rows: number, requestId?: string): Promise<void> {
    return this.client.resize(columns, rows, requestId);
  }

  /**
   * Requests a graceful guest shutdown. A "guest is busy" refusal is not
   * reported as an error (the caller falls through to process-level
   * termination); any other failure is returned so the caller can
   * aggregate it. The underlying socket is destroyed on failure.
   */
  async shutdown(): Promise<GuestShutdownOutcome> {
    try {
      await this.client.shutdown();
      return { acknowledged: true };
    } catch (error) {
      const expected = error instanceof Error && error.message === GUEST_BUSY_SHUTDOWN_MESSAGE;
      this.client.destroy();
      return expected ? { acknowledged: false } : { acknowledged: false, error };
    }
  }
}
