import * as http from 'http';

export interface FirecrackerMachineConfig {
  vcpu_count: number;
  mem_size_mib: number;
  smt?: boolean;
  track_dirty_pages?: boolean;
}

export interface FirecrackerBootSource {
  kernel_image_path: string;
  boot_args?: string;
  initrd_path?: string;
}

export interface FirecrackerRateLimiter {
  bandwidth?: { size: number; refill_time: number; one_time_burst?: number };
  ops?: { size: number; refill_time: number; one_time_burst?: number };
}

export interface FirecrackerDrive {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
  cache_type?: 'Unsafe' | 'Writeback';
  io_engine?: 'Sync' | 'Async';
  rate_limiter?: FirecrackerRateLimiter;
}

export interface FirecrackerVsock {
  guest_cid: number;
  uds_path: string;
}

export interface FirecrackerNetworkInterface {
  iface_id: string;
  host_dev_name: string;
  guest_mac?: string;
  rx_rate_limiter?: FirecrackerRateLimiter;
  tx_rate_limiter?: FirecrackerRateLimiter;
}

export interface FirecrackerLoggerConfig {
  log_path: string;
  level?: 'Error' | 'Warning' | 'Info' | 'Debug' | 'Trace';
  show_level?: boolean;
  show_log_origin?: boolean;
}

export interface FirecrackerMetricsConfig {
  metrics_path: string;
}

export type FirecrackerActionType =
  | 'InstanceStart'
  | 'SendCtrlAltDel'
  | 'FlushMetrics';

export interface FirecrackerInstanceInfo {
  id: string;
  state: 'Not started' | 'Running' | 'Paused';
  vmm_version: string;
  app_name: string;
}

export type FirecrackerVmState = 'Paused' | 'Resumed';

interface FirecrackerErrorBody {
  fault_message?: string;
}

export class FirecrackerApiError extends Error {
  constructor(
    readonly method: string,
    readonly requestPath: string,
    readonly statusCode: number,
    readonly responseBody: string,
    message: string,
  ) {
    super(message);
    this.name = 'FirecrackerApiError';
  }
}

export interface FirecrackerApiClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

/**
 * Typed client for Firecracker's REST API over its Unix domain socket.
 */
export class FirecrackerApiClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: FirecrackerApiClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  putMachineConfig(config: FirecrackerMachineConfig): Promise<void> {
    return this.request('PUT', '/machine-config', config);
  }

  putBootSource(source: FirecrackerBootSource): Promise<void> {
    return this.request('PUT', '/boot-source', source);
  }

  putDrive(drive: FirecrackerDrive): Promise<void> {
    return this.request('PUT', `/drives/${encodeURIComponent(drive.drive_id)}`, drive);
  }

  putVsock(vsock: FirecrackerVsock): Promise<void> {
    return this.request('PUT', '/vsock', vsock);
  }

  putNetworkInterface(networkInterface: FirecrackerNetworkInterface): Promise<void> {
    return this.request(
      'PUT',
      `/network-interfaces/${encodeURIComponent(networkInterface.iface_id)}`,
      networkInterface,
    );
  }

  putLogger(config: FirecrackerLoggerConfig): Promise<void> {
    return this.request('PUT', '/logger', config);
  }

  putMetrics(config: FirecrackerMetricsConfig): Promise<void> {
    return this.request('PUT', '/metrics', config);
  }

  instanceStart(): Promise<void> {
    return this.putAction('InstanceStart');
  }

  putAction(actionType: FirecrackerActionType): Promise<void> {
    return this.request('PUT', '/actions', { action_type: actionType });
  }

  getInstanceInfo(): Promise<FirecrackerInstanceInfo> {
    return this.request('GET', '/');
  }

  patchVmState(state: FirecrackerVmState): Promise<void> {
    return this.request('PATCH', '/vm', { state });
  }

  private request<TResponse = void>(
    method: string,
    requestPath: string,
    payload?: object,
  ): Promise<TResponse> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);

    return new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        const error = new Error(
          `Firecracker API ${method} ${requestPath} timed out after ${this.timeoutMs}ms`,
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
          rejectOnce(new Error(`Firecracker API ${method} ${requestPath} response was aborted`));
        });
        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > 1024 * 1024) {
            const error = new Error('Firecracker API response exceeded 1 MiB');
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
            let parsed: FirecrackerErrorBody | undefined;
            try {
              parsed = responseBody ? JSON.parse(responseBody) as FirecrackerErrorBody : undefined;
            } catch {
              parsed = undefined;
            }
            const detail = parsed?.fault_message || responseBody || 'empty response';
            rejectOnce(new FirecrackerApiError(
              method,
              requestPath,
              statusCode,
              responseBody,
              `Firecracker API ${method} ${requestPath} failed with HTTP ${statusCode}: ${detail}`,
            ));
            return;
          }

          if (!responseBody) {
            resolveOnce(undefined as TResponse);
            return;
          }
          try {
            resolveOnce(JSON.parse(responseBody) as TResponse);
          } catch (error) {
            rejectOnce(new Error(
              `Firecracker API ${method} ${requestPath} returned invalid JSON: ` +
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
