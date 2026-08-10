import * as http from 'http';

/**
 * Typed request/response shapes for the subset of the Cloud Hypervisor
 * `/api/v1` REST surface AWF drives. Field names intentionally match the
 * upstream OpenAPI document
 * (`vmm/src/api/openapi/cloud-hypervisor.yaml`, v53.0) verbatim so this
 * client stays a thin, auditable mapping instead of an abstraction layer.
 */

export interface CloudHypervisorPayloadConfig {
  kernel: string;
  cmdline?: string;
  initramfs?: string;
}

export interface CloudHypervisorCpuTopology {
  threads_per_core?: number;
  cores_per_die?: number;
  dies_per_package?: number;
  packages?: number;
}

export interface CloudHypervisorCpusConfig {
  boot_vcpus: number;
  max_vcpus: number;
  topology?: CloudHypervisorCpuTopology;
  kvm_hyperv?: boolean;
  nested?: boolean;
}

export interface CloudHypervisorMemoryConfig {
  size: number;
  mergeable?: boolean;
  shared?: boolean;
  hugepages?: boolean;
  thp?: boolean;
}

export interface CloudHypervisorDiskConfig {
  id: string;
  path: string;
  readonly?: boolean;
  direct?: boolean;
  /** Must stay `false`: raw images/backing_files off (no qcow2 layering). */
  backing_files?: false;
}

export interface CloudHypervisorNetConfig {
  id: string;
  /** Name of an already-created, already-up host TAP device. */
  tap: string;
  mac: string;
  num_queues?: number;
  queue_size?: number;
}

export interface CloudHypervisorRngConfig {
  src: string;
}

export type CloudHypervisorConsoleMode = 'Off' | 'Pty' | 'Tty' | 'File' | 'Socket' | 'Null';

export interface CloudHypervisorConsoleConfig {
  mode: CloudHypervisorConsoleMode;
  file?: string;
}

export interface CloudHypervisorSerialConfig {
  mode: CloudHypervisorConsoleMode;
  file?: string;
}

export interface CloudHypervisorVsockConfig {
  cid: number;
  socket: string;
}

/** `access` is `"r"`, `"w"`, or `"rw"` per Cloud Hypervisor's Landlock rule parser. */
export interface CloudHypervisorLandlockRule {
  path: string;
  access: 'r' | 'w' | 'rw';
}

export interface CloudHypervisorVmConfig {
  cpus: CloudHypervisorCpusConfig;
  memory: CloudHypervisorMemoryConfig;
  payload: CloudHypervisorPayloadConfig;
  disks?: CloudHypervisorDiskConfig[];
  net?: CloudHypervisorNetConfig[];
  rng?: CloudHypervisorRngConfig;
  serial?: CloudHypervisorSerialConfig;
  console?: CloudHypervisorConsoleConfig;
  vsock?: CloudHypervisorVsockConfig;
  watchdog?: boolean;
  landlock_enable?: boolean;
  landlock_rules?: CloudHypervisorLandlockRule[];
}

export interface CloudHypervisorVmmPingResponse {
  build_version?: string;
  version: string;
  pid?: number;
  features?: string[];
}

export type CloudHypervisorVmState = 'Created' | 'Running' | 'Shutdown' | 'Paused';

export interface CloudHypervisorVmInfo {
  config: CloudHypervisorVmConfig;
  state: CloudHypervisorVmState;
  memory_actual_size?: number;
}

/** Nested counter map: `{ "<device-id>": { "<counter-name>": value } }`. */
export type CloudHypervisorVmCounters = Record<string, Record<string, number>>;

export class CloudHypervisorApiError extends Error {
  constructor(
    readonly method: string,
    readonly requestPath: string,
    readonly statusCode: number,
    readonly responseBody: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudHypervisorApiError';
  }
}

export interface CloudHypervisorApiClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

const API_ROOT = '/api/v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Typed client for Cloud Hypervisor's `/api/v1` REST API over its Unix
 * domain socket. Every call is a bounded-timeout, single JSON round trip;
 * there is no retry or connection reuse logic beyond what Node's `http`
 * module does per request.
 */
export class CloudHypervisorApiClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: CloudHypervisorApiClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  ping(): Promise<CloudHypervisorVmmPingResponse> {
    return this.request('GET', '/vmm.ping');
  }

  vmmShutdown(): Promise<void> {
    return this.request('PUT', '/vmm.shutdown');
  }

  vmCreate(config: CloudHypervisorVmConfig): Promise<void> {
    return this.request('PUT', '/vm.create', config);
  }

  vmBoot(): Promise<void> {
    return this.request('PUT', '/vm.boot');
  }

  vmInfo(): Promise<CloudHypervisorVmInfo> {
    return this.request('GET', '/vm.info');
  }

  vmCounters(): Promise<CloudHypervisorVmCounters> {
    return this.request('GET', '/vm.counters');
  }

  vmShutdown(): Promise<void> {
    return this.request('PUT', '/vm.shutdown');
  }

  vmDelete(): Promise<void> {
    return this.request('PUT', '/vm.delete');
  }

  private request<TResponse = void>(
    method: string,
    endpoint: string,
    payload?: object,
  ): Promise<TResponse> {
    const requestPath = `${API_ROOT}${endpoint}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    return new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const error = new Error(
          `Cloud Hypervisor API ${method} ${requestPath} timed out after ${this.timeoutMs}ms`,
        );
        rejectOnce(error);
        request.destroy(error);
      }, this.timeoutMs);
      const clearTimer = () => clearTimeout(timer);
      const resolveOnce = (value: TResponse) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(value);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(error);
      };

      const request = http.request({
        socketPath: this.options.socketPath,
        path: requestPath,
        method,
        headers: body === undefined
          ? undefined
          : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
      }, (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on('error', rejectOnce);
        response.on('aborted', () => {
          rejectOnce(new Error(`Cloud Hypervisor API ${method} ${requestPath} response was aborted`));
        });
        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            const error = new Error('Cloud Hypervisor API response exceeded 1 MiB');
            rejectOnce(error);
            request.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            rejectOnce(new CloudHypervisorApiError(
              method,
              requestPath,
              statusCode,
              responseBody,
              `Cloud Hypervisor API ${method} ${requestPath} failed with HTTP ${statusCode}: ` +
              `${parseErrorDetail(responseBody)}`,
            ));
            return;
          }

          if (statusCode === 204 || !responseBody) {
            resolveOnce(undefined as TResponse);
            return;
          }
          try {
            resolveOnce(JSON.parse(responseBody) as TResponse);
          } catch (error) {
            rejectOnce(new Error(
              `Cloud Hypervisor API ${method} ${requestPath} returned invalid JSON: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            ));
          }
        });
      });

      request.on('error', rejectOnce);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}

/**
 * Cloud Hypervisor error bodies are a JSON array of chained error messages
 * (outermost first), e.g. `["failed to create VM", "invalid disk path"]`.
 * Falls back to the raw body when the shape is unexpected.
 */
function parseErrorDetail(responseBody: string): string {
  if (!responseBody) return 'empty response';
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) {
      return parsed.length > 0 ? parsed.join(': ') : responseBody;
    }
  } catch {
    // Fall through to the raw body below.
  }
  return responseBody;
}
