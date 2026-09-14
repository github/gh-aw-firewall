import { Writable } from 'stream';

export const CLOUD_HYPERVISOR_GUEST_WORKSPACE = '/workspace';
export const MCP_GATEWAY_PORT = 8080;
/**
 * Generous, not a tight few-second timeout. Live-KVM validation on
 * GitHub-hosted runners showed the guest's own vCPU getting scheduled so
 * rarely under nested virtualization (see the CLOUD_HYPERVISOR_GUEST_READY_
 * MAX_WAIT_MS comment in cloud-hypervisor/manager.ts for the same
 * phenomenon during boot) that even a fully-correct network path (tap,
 * nftables, vnet_hdr all confirmed working via live diagnostics — response
 * packets reaching the host-side veth) could still leave a short-lived
 * guest command like `nc -z -w 5` unable to get enough real CPU time to
 * finish its own connect() before that 5-second budget elapsed. A short
 * probe timeout would abort a guest that is merely slow to be scheduled,
 * not one with a broken network path.
 */
export const CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS = 90_000;
export const CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_ATTEMPTS = 3;
export const CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS = 60;
export const CLOUD_HYPERVISOR_API_PROXY_PROBE_TIMEOUT_SECONDS = 20;
export const CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_BACKOFF_SECONDS = 6;
export const CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_SCHEDULING_GRACE_MS = 30_000;

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function connectivityProbeTimeoutMs(
  topologyPeerCount: number,
  enableApiProxy: boolean,
): number {
  const tcpLegCount = 1 + topologyPeerCount;
  const tcpBudgetSeconds = tcpLegCount * (
    CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_ATTEMPTS *
      CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS +
    CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_BACKOFF_SECONDS
  );
  const apiProxyBudgetSeconds = enableApiProxy
    ? CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_ATTEMPTS *
        CLOUD_HYPERVISOR_API_PROXY_PROBE_TIMEOUT_SECONDS +
      CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_BACKOFF_SECONDS
    : 0;
  return (
    (tcpBudgetSeconds + apiProxyBudgetSeconds) * 1_000 +
    CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_SCHEDULING_GRACE_MS
  );
}

export function createBoundedOutputCollector(maxBytes = 4096): {
  readonly stream: Writable;
  toString(): string;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (total < maxBytes) {
        const remaining = maxBytes - total;
        const boundedChunk = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(boundedChunk);
        total += boundedChunk.length;
      }
      callback();
    },
  });
  return {
    stream,
    toString: () => Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
  };
}
