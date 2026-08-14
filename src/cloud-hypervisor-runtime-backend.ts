import type { Readable } from 'stream';
import { Writable } from 'stream';
import type { WorkflowDependencies } from './cli-workflow';
import type { ExternalAgentRuntimeBackend } from './external-runtime-backend';
import {
  API_PROXY_IP,
  NETWORK_SUBNET,
  SQUID_IP,
} from './config/network-policy';
import {
  resolveMicrovmInfrastructure,
  type MicrovmInfrastructureSnapshot,
} from './microvm/infrastructure';
import type {
  GuestExecutionRequest,
  GuestExecutionResult,
} from './microvm/vsock-client';
import type { CloudHypervisorPreflightResult } from './cloud-hypervisor/preflight';
import { CloudHypervisorManager } from './cloud-hypervisor/manager';
import { runCloudHypervisorPreflight } from './cloud-hypervisor/preflight';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { logger } from './logger';
import { buildGuestEnvironment } from './microvm/guest-environment';
import type { CloudHypervisorOptions, WrapperConfig } from './types';
import {
  assertCloudHypervisorRuntimeCompatibility,
  requireCloudHypervisorConfig,
} from './cloud-hypervisor/runtime-validation';
import {
  resolveCloudHypervisorExports,
  type CloudHypervisorDirectoryExport,
} from './cloud-hypervisor/exports';
export {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
} from './cloud-hypervisor/runtime-validation';

const CLOUD_HYPERVISOR_GUEST_WORKSPACE = '/workspace';
const CLOUD_HYPERVISOR_GUEST_HOME = `${CLOUD_HYPERVISOR_GUEST_WORKSPACE}/.awf-home`;
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
const CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS = 90_000;
const CLOUD_HYPERVISOR_CANCEL_GRACE_MS = 3_000;
const CLOUD_HYPERVISOR_MAX_TIMEOUT_MS = 86_400_000;
const MCP_GATEWAY_PORT = 8080;

interface CloudHypervisorBackendLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface CloudHypervisorManagerAdapter {
  readonly paths: Pick<CloudHypervisorManager['paths'], 'runDirectory'>;
  readonly guestIp?: string;
  readonly networkNamespace?: string;
  start(): Promise<unknown>;
  startInstance(): Promise<void>;
  execute(request: GuestExecutionRequest): Promise<GuestExecutionResult>;
  cancel(reason?: string, requestId?: string): Promise<void>;
  writeStdin(data: Buffer, requestId?: string): Promise<void>;
  endStdin(requestId?: string): Promise<void>;
  stop(options?: { preserve?: boolean; beforeCleanup?: () => Promise<void> }): Promise<void>;
  collectDiagnostics(directory: string): Promise<void>;
}

export interface CloudHypervisorRuntimeBackendDependencies {
  startInfrastructure: WorkflowDependencies['startContainers'];
  preflight(config: CloudHypervisorOptions): Promise<CloudHypervisorPreflightResult>;
  resolveInfrastructure(
    enableApiProxy: boolean,
    ipPath?: string,
    topologyPeerNames?: readonly string[],
  ): Promise<MicrovmInfrastructureSnapshot>;
  createManager(
    config: CloudHypervisorOptions,
    workDir: string,
    infrastructure: MicrovmInfrastructureSnapshot,
    exports: readonly CloudHypervisorDirectoryExport[],
    identity: { uid: number; gid: number },
  ): CloudHypervisorManagerAdapter;
  resolveExports(): Promise<CloudHypervisorDirectoryExport[]>;
  identity(): { uid: number; gid: number };
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  logger: CloudHypervisorBackendLogger;
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): CloudHypervisorRuntimeBackendDependencies {
  return {
    startInfrastructure,
    preflight: runCloudHypervisorPreflight,
    resolveInfrastructure: (enableApiProxy, ipPath, topologyPeerNames) =>
      resolveMicrovmInfrastructure(enableApiProxy, undefined, ipPath, topologyPeerNames),
    createManager: (config, workDir, infrastructure, exports, identity) =>
      new CloudHypervisorManager(
        config,
        workDir,
        undefined,
        undefined,
        {
          infrastructureBridge: infrastructure.bridgeName,
          enableApiProxy: Boolean(infrastructure.apiProxyIp),
          apiProxyIp: infrastructure.apiProxyIp,
          controlPeers: Object.values(infrastructure.topologyPeerIps).map((ip) => ({
            ip,
            ports: [MCP_GATEWAY_PORT],
          })),
          hostAliases: infrastructure.topologyPeerIps,
        },
        {
          exports,
          supervisorBinaryPath: config.supervisorPath!,
          supervisorSha256: config.sha256!.supervisor!,
          identity,
        },
      ),
    resolveExports: () => resolveCloudHypervisorExports(),
    identity: () => ({
      uid: Number(getSafeHostUid()),
      gid: Number(getSafeHostGid()),
    }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    logger,
  };
}

/** @internal Exposed only for focused default-policy tests. */
export const cloudHypervisorRuntimeTestHelpers = { defaultDependencies };

/** Stateful adapter for an explicitly enabled, fail-closed Cloud Hypervisor microVM. */
export class CloudHypervisorRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = 'cloud-hypervisor';

  private manager: CloudHypervisorManagerAdapter | undefined;
  private environment: Record<string, string> | undefined;
  private activeExecution:
    | { requestId: string; promise: Promise<GuestExecutionResult> }
    | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private identity: { uid: number; gid: number } | undefined;
  private preflightResult: CloudHypervisorPreflightResult | undefined;
  private infrastructure: MicrovmInfrastructureSnapshot | undefined;
  private diagnosticsCollected = false;

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: CloudHypervisorRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    const cloudHypervisor = requireCloudHypervisorConfig(this.config);
    if (
      this.config.agentTimeout !== undefined &&
      this.config.agentTimeout * 60_000 > CLOUD_HYPERVISOR_MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `Cloud Hypervisor preview supports --agent-timeout values up to ${
          CLOUD_HYPERVISOR_MAX_TIMEOUT_MS / 60_000
        } minutes`,
      );
    }
    assertCloudHypervisorRuntimeCompatibility(this.config, cloudHypervisor);
    this.preflightResult = await this.dependencies.preflight(cloudHypervisor);
  }

  readonly start: WorkflowDependencies['startContainers'] = async (
    workDir,
    allowedDomains,
    proxyLogsDir,
    skipPull,
    onNetworkReady,
    onInfrastructureReady,
  ) => {
    let stage = 'preflight';
    this.dependencies.logger.info(
      '[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled',
    );
    try {
      await this.preflight();
      stage = 'compose-infrastructure';
      await this.dependencies.startInfrastructure(
        workDir,
        allowedDomains,
        proxyLogsDir,
        skipPull,
        onNetworkReady,
        onInfrastructureReady,
      );

      stage = 'infrastructure-discovery';
      const cloudHypervisor = requireCloudHypervisorConfig(this.config);
      const infrastructure = await this.dependencies.resolveInfrastructure(
        Boolean(this.config.enableApiProxy),
        this.preflightResult?.tools.ip,
        this.config.topologyAttach,
      );
      this.infrastructure = infrastructure;
      this.identity = this.dependencies.identity();
      const exports = await this.dependencies.resolveExports();
      this.manager = this.dependencies.createManager(
        cloudHypervisor,
        workDir,
        infrastructure,
        exports,
        this.identity,
      );

      stage = 'topology-revalidation';
      await infrastructure.revalidate();
      stage = 'vmm-configuration';
      await this.manager.start();
      if (!this.manager.guestIp) {
        throw new Error('Cloud Hypervisor manager did not expose the configured guest IP');
      }
      this.environment = buildCloudHypervisorGuestEnvironment(
        this.config,
        infrastructure,
        this.manager.guestIp,
        exports,
      );
      stage = 'guest-boot';
      await this.manager.startInstance();
      stage = 'guest-connectivity';
      await this.probeGuestConnectivity();
      this.dependencies.logger.info('[cloud-hypervisor] stage=ready');
    } catch (error) {
      this.dependencies.logger.warn(
        `[cloud-hypervisor] stage=${stage} status=failed: ${formatError(error)}`,
      );
      // Collect diagnostics (guest serial console, Cloud Hypervisor log,
      // network plan, counters) once the Cloud Hypervisor process is
      // confirmed terminated but before stop() deletes the private run
      // directory. Collecting any earlier (before the process actually
      // exits) can observe a still-empty guest serial console log, since
      // Cloud Hypervisor does not guarantee flushing buffered console
      // output to disk until the process exits. Without this hook at all,
      // a startup failure would leave nothing for the outer,
      // --diagnostic-logs-gated collectDiagnostics() call (invoked later,
      // from the CLI's cleanup path) to find — it would silently no-op on
      // now-ENOENT paths.
      const collectPreCleanupDiagnostics =
        this.config.diagnosticLogs && this.manager
          ? async () => {
              try {
                await this.collectDiagnostics();
              } catch (diagnosticsError) {
                this.dependencies.logger.warn(
                  `[cloud-hypervisor] failed to collect pre-cleanup diagnostics: ${formatError(diagnosticsError)}`,
                );
              }
            }
          : undefined;
      try {
        await this.manager?.stop({ beforeCleanup: collectPreCleanupDiagnostics });
        // Mark the backend stopped so the CLI's own cleanup path (which
        // unconditionally calls backend.stop() again after any startup
        // failure) doesn't invoke a second, redundant manager.stop() --
        // by this point network/cgroup/run-directory teardown has already
        // completed. On a *failed* cleanup here, deliberately leave
        // `stopped` false so that outer cleanup call gets a genuine retry
        // attempt rather than silently no-op-ing on a botched teardown.
        this.stopped = true;
      } catch (cleanupError) {
        const combined = new Error(
          `Cloud Hypervisor startup failed: ${formatError(error)}; ` +
          `microVM cleanup also failed: ${formatError(cleanupError)}`,
        );
        Object.defineProperty(combined, 'cause', { value: error });
        Object.assign(combined, { cleanupCause: cleanupError });
        throw combined;
      }
      throw error;
    }
  };

  readonly exec: WorkflowDependencies['runAgentCommand'] = async (
    _workDir,
    _allowedDomains,
    _proxyLogsDir,
    agentTimeoutMinutes,
  ) => {
    const manager = this.manager;
    const environment = this.environment;
    const identity = this.identity;
    if (!manager || !environment || !identity) {
      throw new Error('Cloud Hypervisor microVM is not ready');
    }
    if (this.config.tty) {
      throw new Error(
        'Cloud Hypervisor preview guest supervisor does not support TTY execution',
      );
    }

    const requestId = `agent-${process.pid}-${Date.now()}`;
    const timeoutMs = agentTimeoutMinutes === undefined
      ? undefined
      : agentTimeoutMinutes * 60_000;
    const execution = manager.execute({
      requestId,
      argv: ['/bin/sh', '-lc', this.config.agentCommand],
      env: environment,
      cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
      ...identity,
      tty: false,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      stdout: this.dependencies.stdout,
      stderr: this.dependencies.stderr,
    });
    this.activeExecution = { requestId, promise: execution };

    let forwarding = Promise.resolve();
    let stdinEnded = false;
    const forward = (operation: () => Promise<void>): void => {
      forwarding = forwarding.then(operation).catch((error) => {
        this.dependencies.logger.warn(
          `Cloud Hypervisor guest stdin forwarding failed: ${formatError(error)}`,
        );
        return manager.cancel('stdin forwarding failure', requestId).catch(() => undefined);
      });
    };
    const onData = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      forward(() => manager.writeStdin(data, requestId));
    };
    const onEnd = (): void => {
      if (stdinEnded) return;
      stdinEnded = true;
      forward(() => manager.endStdin(requestId));
    };
    this.dependencies.stdin.on('data', onData);
    this.dependencies.stdin.once('end', onEnd);
    if (this.dependencies.stdin.readableEnded) onEnd();

    try {
      const result = await execution;
      this.dependencies.logger.info(
        `[cloud-hypervisor] Agent command exited with code ${result.exitCode}` +
        (result.signal ? ` (${result.signal})` : ''),
      );
      return { exitCode: result.exitCode };
    } finally {
      this.dependencies.stdin.off('data', onData);
      this.dependencies.stdin.off('end', onEnd);
      await forwarding;
      this.activeExecution = undefined;
    }
  };

  async collectDiagnostics(): Promise<void> {
    // Idempotent: main-action.ts's cleanup handler unconditionally calls
    // this once during shutdown, but start()'s own failure path (above)
    // already collects diagnostics *before* stop() tears down the
    // network/cgroup/run directory (so buffered guest console output is
    // captured, and the live network state is inspectable before the
    // namespace is deleted). Without this guard, that second, redundant
    // call would run *after* teardown and clobber the earlier, more
    // useful snapshot with an empty/unavailable one (e.g.
    // network-diagnostics.txt regressing to "network namespace not set
    // up" once cleanup() has already cleared it) -- discovered via
    // live-KVM validation.
    if (this.diagnosticsCollected || !this.manager) return;
    const directory = this.config.auditDir
      ? `${this.config.auditDir}/cloud-hypervisor`
      : `${this.config.workDir}/diagnostics/cloud-hypervisor`;
    await this.manager.collectDiagnostics(directory);
    this.diagnosticsCollected = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopping) return this.stopping;
    this.stopping = this.stopManager(false);
    try {
      await this.stopping;
      this.stopped = true;
    } finally {
      this.stopping = undefined;
    }
  }

  async preserve(): Promise<void> {
    if (this.stopped) return;
    if (this.stopping) return this.stopping;
    this.stopping = this.stopManager(true);
    try {
      await this.stopping;
      this.stopped = true;
      if (this.manager) {
        this.dependencies.logger.info(
          `[cloud-hypervisor] Preserved run directory: ${this.manager.paths.runDirectory}`,
        );
        this.dependencies.logger.info(
          `[cloud-hypervisor] Preserved images: ${this.config.workDir}/firecracker-images`,
        );
        if (this.manager.networkNamespace) {
          this.dependencies.logger.info(
            `[cloud-hypervisor] Preserved network namespace: ${this.manager.networkNamespace}`,
          );
        }
      }
    } finally {
      this.stopping = undefined;
    }
  }

  private async stopManager(preserve: boolean): Promise<void> {
    const active = this.activeExecution;
    if (active && this.manager) {
      try {
        await this.manager.cancel('AWF cleanup', active.requestId);
      } catch {
        // Process termination below remains authoritative.
      }
      await Promise.race([
        active.promise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, CLOUD_HYPERVISOR_CANCEL_GRACE_MS)),
      ]);
    }
    await this.manager?.stop({ preserve });
  }

  private async probeGuestConnectivity(): Promise<void> {
    const manager = this.manager!;
    const environment = this.environment!;
    const identity = this.identity;
    if (!identity) {
      throw new Error('Cloud Hypervisor guest identity is not ready');
    }
    // Keep the readiness probe limited to the ARC build-tools baseline even
    // though that userspace also includes curl. `nc -z` verifies Squid's
    // TCP listener is up without depending on HTTP status-code semantics
    // (a raw, non-proxy-style request to Squid's own port returns a 4xx
    // error page by design, which BusyBox wget would treat as a script
    // failure by default, unlike curl without `--fail`). `-v` makes nc
    // print an "open"/error line instead of staying silent, so
    // a failure has *something* to report. The API proxy check does
    // expect a real 2xx from its `/reflect` endpoint, so wget is used
    // there directly (matching the smoke test's own api-proxy-reflect
    // case), with the proxy env vars unset so the request reaches the
    // sidecar directly rather than being routed through Squid. Discovered
    // via live-KVM validation on the original BusyBox rootfs.
    const squidProbe = `nc -v -z -w 60 ${SQUID_IP} 3128`;
    const apiProxyProbe = this.config.enableApiProxy
      ? ` && (unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; ` +
        `wget -q -T 20 -O /dev/null http://${API_PROXY_IP}:10000/reflect)`
      : '';
    const topologyPeerProbe = Object.values(this.infrastructure?.topologyPeerIps ?? {})
      .map((ip) => ` && nc -v -z -w 60 ${ip} ${MCP_GATEWAY_PORT}`)
      .join('');
    const topologyPeerCount = Object.keys(this.infrastructure?.topologyPeerIps ?? {}).length;
    // Capture (bounded) stdout/stderr so a probe failure can report which
    // leg failed and why, rather than only a bare exit code -- useful for
    // diagnosing this compound nc-then-wget command without a full guest
    // command execution's live output stream.
    const stdoutCollector = createBoundedOutputCollector();
    const stderrCollector = createBoundedOutputCollector();
    const result = await manager.execute({
      requestId: `probe-${process.pid}-${Date.now()}`,
      argv: ['/bin/sh', '-c', `set -eu; ${squidProbe}${apiProxyProbe}${topologyPeerProbe}`],
      env: environment,
      cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
      ...identity,
      timeoutMs: CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS + topologyPeerCount * 60_000,
      stdout: stdoutCollector.stream,
      stderr: stderrCollector.stream,
    });
    if (result.exitCode !== 0) {
      const stdout = stdoutCollector.toString().trim();
      const stderr = stderrCollector.toString().trim();
      const netState = await this.captureGuestNetworkStateForDiagnostics();
      const detail = [
        stdout && `stdout: ${stdout}`,
        stderr && `stderr: ${stderr}`,
        netState && `guest network state: ${netState}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join('; ');
      throw new Error(
        `Cloud Hypervisor guest connectivity probe failed with exit code ${result.exitCode}` +
          (detail ? ` (${detail})` : ''),
      );
    }
    this.dependencies.logger.info(
      '[cloud-hypervisor] Guest supervisor and trusted service connectivity verified',
    );
  }

  /**
   * Best-effort diagnostic-only helper: on a connectivity probe failure,
   * capture the guest's own view of its network configuration (interface
   * addresses and routing table) so a live-KVM failure log shows *why* the
   * guest couldn't reach Squid/API proxy (e.g. missing IP, missing
   * default route) rather than only a bare exit code. Never throws --
   * failures here are folded into an empty string rather than masking the
   * original probe failure.
   */
  private async captureGuestNetworkStateForDiagnostics(): Promise<string> {
    const manager = this.manager;
    const environment = this.environment;
    const identity = this.identity;
    if (!manager || !environment || !identity) return '';
    try {
      const stdoutCollector = createBoundedOutputCollector();
      await manager.execute({
        requestId: `probe-netdiag-${process.pid}-${Date.now()}`,
        // `ip addr show` includes each interface's MAC (compared against
        // the plan's configured guest MAC and the nftables anti-spoof
        // rule during triage); note this deliberately omits `-d`
        // (detailed) since the guest's minimal BusyBox `ip` applet does
        // not reliably support it (unlike the real iproute2 used
        // host-side in network.ts's captureDiagnosticsInNamespace).
        // `ip neigh show` confirms the guest actually resolved the
        // gateway's MAC via ARP (a failure here would mean the guest
        // never got a reply to its own ARP request, independent of
        // anything TCP/Squid-related).
        argv: ['/bin/sh', '-c', 'ip addr show; echo ---; ip route show; echo ---; ip neigh show'],
        env: environment,
        cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
        ...identity,
        timeoutMs: CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS,
        stdout: stdoutCollector.stream,
      });
      return stdoutCollector.toString().trim();
    } catch {
      return '';
    }
  }
}

export function buildCloudHypervisorGuestEnvironment(
  config: WrapperConfig,
  infrastructure: Pick<
    MicrovmInfrastructureSnapshot,
    'squidIp' | 'apiProxyIp' | 'topologyPeerIps'
  >,
  guestIp = '100.64.0.2',
  exports: readonly CloudHypervisorDirectoryExport[] = [],
): Record<string, string> {
  const networkConfig = {
    subnet: NETWORK_SUBNET,
    squidIp: infrastructure.squidIp,
    agentIp: guestIp,
    proxyIp: infrastructure.apiProxyIp,
  };
  const environment = buildGuestEnvironment({
    config,
    networkConfig,
    home: CLOUD_HYPERVISOR_GUEST_HOME,
    workspace: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
    runtimeName: 'cloud-hypervisor',
    runtimeDisplayName: 'Cloud Hypervisor',
  });
  const topologyPeerBypasses = Object.entries(infrastructure.topologyPeerIps)
    .flatMap(([name, ip]) => [name, ip]);
  if (topologyPeerBypasses.length > 0) {
    const noProxy = new Set((environment.NO_PROXY ?? '').split(',').filter(Boolean));
    topologyPeerBypasses.forEach((peer) => noProxy.add(peer));
    environment.NO_PROXY = [...noProxy].join(',');
    environment.no_proxy = environment.NO_PROXY;
  }
  environment.GITHUB_WORKSPACE = CLOUD_HYPERVISOR_GUEST_WORKSPACE;
  for (const name of ['RUNNER_TOOL_CACHE', 'AGENT_TOOLSDIRECTORY', 'RUNNER_TEMP'] as const) {
    delete environment[name];
  }
  const toolCache = exports.find((entry) => entry.tag === 'runner-tool-cache');
  if (toolCache) {
    if (process.env.RUNNER_TOOL_CACHE) environment.RUNNER_TOOL_CACHE = toolCache.target;
    else environment.AGENT_TOOLSDIRECTORY = toolCache.target;
  }
  const runnerTemp = exports.find((entry) => entry.tag === 'runner-temp-gh-aw');
  if (runnerTemp) {
    environment.RUNNER_TEMP = runnerTemp.target.slice(0, -'/gh-aw'.length);
  }
  return environment;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A bounded, in-memory Writable for capturing a guest command's stdout or
 * stderr without printing it live (unlike the real agent command, whose
 * output streams directly to the user). Used to enrich probeGuestConnectivity()
 * failure messages with what the guest actually printed, discarding
 * anything past the byte cap so a runaway/looping command can't grow
 * memory unbounded.
 */
function createBoundedOutputCollector(maxBytes = 4096): {
  readonly stream: Writable;
  toString(): string;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (total < maxBytes) {
        chunks.push(chunk);
        total += chunk.length;
      }
      callback();
    },
  });
  return {
    stream,
    toString: () => Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
  };
}

export function createCloudHypervisorRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): CloudHypervisorRuntimeBackend {
  return new CloudHypervisorRuntimeBackend(config, defaultDependencies(startInfrastructure));
}
