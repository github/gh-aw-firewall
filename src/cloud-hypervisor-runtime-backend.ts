import type { Readable, Writable } from 'stream';
import type { WorkflowDependencies } from './cli-workflow';
import type { ExternalAgentRuntimeBackend } from './external-runtime-backend';
import {
  API_PROXY_IP,
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
import {
  CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS,
  CloudHypervisorRetryableReadinessError,
  runCloudHypervisorPreflight,
} from './cloud-hypervisor/preflight';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { logger } from './logger';
import type { CloudHypervisorOptions, WrapperConfig } from './types';
import {
  assertCloudHypervisorRuntimeCompatibility,
  requireCloudHypervisorConfig,
} from './cloud-hypervisor/runtime-validation';
import {
  resolveCloudHypervisorExports,
  type CloudHypervisorDirectoryExport,
} from './cloud-hypervisor/exports';
import { planCloudHypervisorFilesystemWriteEnforcement } from './cloud-hypervisor/filesystem-write-enforcement';
import type { VirtiofsdMountEnforcement } from './cloud-hypervisor/virtiofsd';
import { buildCloudHypervisorGuestEnvironment } from './cloud-hypervisor/guest-environment-builder';
import {
  CLOUD_HYPERVISOR_API_PROXY_PROBE_TIMEOUT_SECONDS,
  CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_ATTEMPTS,
  CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS,
  connectivityProbeTimeoutMs,
  createBoundedOutputCollector,
  formatError,
  shellSingleQuote,
} from './cloud-hypervisor/backend-utils';
export { buildCloudHypervisorGuestEnvironment };
export { CloudHypervisorRetryableReadinessError } from './cloud-hypervisor/preflight';
export {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
} from './cloud-hypervisor/runtime-validation';

const CLOUD_HYPERVISOR_GUEST_WORKSPACE = '/workspace';
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
const CLOUD_HYPERVISOR_GUEST_NETWORK_READY_TIMEOUT_MS = CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS;
const CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_INITIAL_DELAY_SECONDS = 2;
const CLOUD_HYPERVISOR_BOOT_RETRY_DELAYS_MS = [5_000, 10_000] as const;
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
  readonly guestGatewayIp?: string;
  readonly guestPrefixLength?: number;
  readonly guestInterfaceName?: string;
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

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
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
    mountEnforcement?: VirtiofsdMountEnforcement,
  ): CloudHypervisorManagerAdapter;
  resolveExports(): Promise<CloudHypervisorDirectoryExport[]>;
  identity(): { uid: number; gid: number };
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  logger: CloudHypervisorBackendLogger;
  sleep(milliseconds: number): Promise<void>;
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): CloudHypervisorRuntimeBackendDependencies {
  return {
    startInfrastructure,
    preflight: runCloudHypervisorPreflight,
    resolveInfrastructure: (enableApiProxy, ipPath, topologyPeerNames) =>
      resolveMicrovmInfrastructure(enableApiProxy, undefined, ipPath, topologyPeerNames),
    createManager: (config, workDir, infrastructure, exports, identity, mountEnforcement) =>
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
          ...(mountEnforcement ? { mountEnforcement } : {}),
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
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

function createBackendWithDependencies(
  config: WrapperConfig,
  dependencies: CloudHypervisorRuntimeBackendDependencies,
): ExternalAgentRuntimeBackend {
  return new CloudHypervisorRuntimeBackend(config, dependencies);
}

/** @internal Exposed only for focused default-policy tests. */
// ts-prune-ignore-next
export const cloudHypervisorRuntimeTestHelpers = {
  defaultDependencies,
  createBackendWithDependencies,
};

/**
 * Stateful adapter for an explicitly enabled, fail-closed Cloud Hypervisor microVM.
 *
 * Private implementation detail. Production code must go through
 * {@link createCloudHypervisorRuntimeBackend} instead.
 */
class CloudHypervisorRuntimeBackend implements ExternalAgentRuntimeBackend {
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
  private agentExecutionStarted = false;
  private readonly failedBootDiagnostics: string[] = [];

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
      stage = 'filesystem-write-policy';
      // Planned before the boot loop so an invalid or unmatched
      // `filesystem.allowWrite` entry fails closed before virtiofsd, the VMM,
      // or the guest is launched, and so every boot attempt reuses one
      // decision instead of re-resolving host paths per attempt.
      const { exports, mountEnforcement, writeBoundary } = planCloudHypervisorFilesystemWriteEnforcement(
        await this.dependencies.resolveExports(),
        this.config.filesystemAllowWrite,
      );
      if (writeBoundary.length > 0) {
        // Without this line a guest path missing from `filesystem.allowWrite`
        // only ever surfaces as an unexplained EROFS inside the workload.
        this.dependencies.logger.info(
          `[cloud-hypervisor] stage=filesystem-write-policy boundary ${writeBoundary.join(' ')} ` +
          '(writes outside these paths fail with EROFS; for paths under originally writable exports, ' +
          'widen filesystem.allowWrite to permit them)',
        );
      }
      stage = 'topology-revalidation';
      await infrastructure.revalidate();
      for (
        let bootAttempt = 1;
        bootAttempt <= CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS;
        bootAttempt += 1
      ) {
        if (bootAttempt > 1) {
          const delay = CLOUD_HYPERVISOR_BOOT_RETRY_DELAYS_MS[bootAttempt - 2];
          this.dependencies.logger.warn(
            `[cloud-hypervisor] stage=boot-recovery attempt=${bootAttempt}/` +
            `${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS} delay=${delay}ms`,
          );
          await this.dependencies.sleep(delay);
        }
        this.manager = this.dependencies.createManager(
          cloudHypervisor,
          workDir,
          infrastructure,
          exports,
          this.identity,
          mountEnforcement,
        );
        try {
          stage = 'vmm-configuration';
          await this.manager.start();
          const {
            guestIp,
            guestGatewayIp,
            guestPrefixLength,
            guestInterfaceName,
          } = this.manager;
          if (
            !guestIp ||
            !guestGatewayIp ||
            guestPrefixLength === undefined ||
            !guestInterfaceName
          ) {
            throw new Error(
              'Cloud Hypervisor manager did not expose the configured guest network plan',
            );
          }
          this.environment = buildCloudHypervisorGuestEnvironment(
            this.config,
            infrastructure,
            guestIp,
            exports,
          );
          stage = 'guest-boot';
          await this.manager.startInstance();
          stage = 'guest-network-readiness';
          await this.waitForGuestNetworkReady(bootAttempt);
          stage = 'guest-connectivity';
          await this.probeGuestConnectivity(bootAttempt);
          this.dependencies.logger.info(
            `[cloud-hypervisor] stage=ready boot-attempt=${bootAttempt}/` +
            `${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}`,
          );
          return;
        } catch (error) {
          this.dependencies.logger.warn(
            `[cloud-hypervisor] stage=${stage} status=failed ` +
            `boot-attempt=${bootAttempt}/${CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS}: ` +
            formatError(error),
          );
          const finalAttempt = bootAttempt === CLOUD_HYPERVISOR_MAX_BOOT_ATTEMPTS;
          await this.cleanupFailedBootAttempt(bootAttempt, error, finalAttempt);
          if (
            error instanceof CloudHypervisorRetryableReadinessError &&
            !this.agentExecutionStarted &&
            !finalAttempt
          ) {
            continue;
          }
          if (error instanceof CloudHypervisorRetryableReadinessError) {
            error.attachDiagnostics(this.failedBootDiagnostics, finalAttempt);
          }
          this.stopped = true;
          throw error;
        }
      }
    } catch (error) {
      if (!this.stopped) {
        this.dependencies.logger.warn(
          `[cloud-hypervisor] stage=${stage} status=failed: ${formatError(error)}`,
        );
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
    this.agentExecutionStarted = true;
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
          `[cloud-hypervisor] Preserved images: ${this.config.workDir}/microvm-images`,
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

  private async probeGuestConnectivity(bootAttempt: number): Promise<void> {
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
    const probes = [
      {
        name: 'squid',
        command: `nc -v -z -w ${CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS} ` +
          `${SQUID_IP} 3128`,
      },
    ];
    if (this.config.enableApiProxy) {
      probes.push({
        name: 'api-proxy',
        command:
          `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; ` +
          `wget -q -T ${CLOUD_HYPERVISOR_API_PROXY_PROBE_TIMEOUT_SECONDS} ` +
          `-O /dev/null http://${API_PROXY_IP}:10000/reflect`,
      });
    }
    for (const [name, ip] of Object.entries(this.infrastructure?.topologyPeerIps ?? {})) {
      probes.push({
        name: `topology-peer-${name}`,
        command: `nc -v -z -w ${CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS} ` +
          `${ip} ${MCP_GATEWAY_PORT}`,
      });
    }
    const topologyPeerCount = Object.keys(this.infrastructure?.topologyPeerIps ?? {}).length;
    const probeFunction = [
      'probe_leg() {',
      '  leg="$1"',
      '  command="$2"',
      '  attempt=1',
      `  delay=${CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_INITIAL_DELAY_SECONDS}`,
      '  while true; do',
      '    if /bin/sh -c "$command"; then',
      '      return 0',
      '    else',
      '      status=$?',
      '    fi',
      '    echo "connectivity leg=$leg attempt=$attempt exit=$status" >&2',
      '    if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then',
      '      echo "connectivity leg=$leg permanent-command-failure exit=$status" >&2',
      '      return "$status"',
      '    fi',
      `    if [ "$attempt" -ge ${CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_ATTEMPTS} ]; then`,
      '      echo "connectivity leg=$leg exhausted attempts=$attempt exit=$status" >&2',
      '      return "$status"',
      '    fi',
      '    sleep "$delay"',
      '    attempt=$((attempt + 1))',
      '    delay=$((delay * 2))',
      '  done',
      '}',
    ].join('\n');
    const probeCommands = probes
      .map(({ name, command }) =>
        `probe_leg ${shellSingleQuote(name)} ${shellSingleQuote(command)} || exit $?`)
      .join('\n');
    // Capture (bounded) stdout/stderr so a probe failure can report which
    // leg failed and why, rather than only a bare exit code -- useful for
    // diagnosing this compound nc-then-wget command without a full guest
    // command execution's live output stream.
    const stdoutCollector = createBoundedOutputCollector();
    const stderrCollector = createBoundedOutputCollector();
    let result: GuestExecutionResult;
    try {
      result = await manager.execute({
        requestId: `probe-${process.pid}-${Date.now()}`,
        argv: ['/bin/sh', '-c', `set -u\n${probeFunction}\n${probeCommands}`],
        env: environment,
        cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
        ...identity,
        timeoutMs: connectivityProbeTimeoutMs(
          topologyPeerCount,
          Boolean(this.config.enableApiProxy),
        ),
        stdout: stdoutCollector.stream,
        stderr: stderrCollector.stream,
      });
    } catch (error) {
      throw new CloudHypervisorRetryableReadinessError(
        'guest-connectivity',
        bootAttempt,
        `connectivity probe could not execute: ${formatError(error)}`,
        error,
      );
    }
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
      const failure =
        `Cloud Hypervisor guest connectivity probe failed with exit code ${result.exitCode}` +
        (detail ? ` (${detail})` : '');
      if (result.exitCode === 126 || result.exitCode === 127) {
        throw new Error(`Cloud Hypervisor guest connectivity configuration is invalid: ${failure}`);
      }
      throw new CloudHypervisorRetryableReadinessError(
        'guest-connectivity',
        bootAttempt,
        failure,
      );
    }
    this.dependencies.logger.info(
      '[cloud-hypervisor] Guest supervisor and trusted service connectivity verified',
    );
  }

  /**
   * Verify the guest supervisor's network-readiness contract before running
   * the more expensive service-connectivity probe. Current supervisors bring
   * loopback up before opening the vsock listener; this bounded check also
   * fails clearly if a mismatched guest image violates that contract.
   */
  private async waitForGuestNetworkReady(bootAttempt: number): Promise<void> {
    const manager = this.manager!;
    const environment = this.environment!;
    const identity = this.identity;
    if (!identity) {
      throw new Error('guest-network-not-ready: Cloud Hypervisor guest identity is not ready');
    }
    const guestIp = manager.guestIp;
    const guestGatewayIp = manager.guestGatewayIp;
    const guestPrefixLength = manager.guestPrefixLength;
    const guestInterfaceName = manager.guestInterfaceName;
    if (
      !guestIp ||
      !guestGatewayIp ||
      guestPrefixLength === undefined ||
      !guestInterfaceName
    ) {
      throw new Error('Cloud Hypervisor guest network plan is not ready');
    }
    const expectedAddress = `${guestIp}/${guestPrefixLength}`;
    const script = [
      'attempt=1',
      'delay=1',
      `interface=${shellSingleQuote(guestInterfaceName)}`,
      `address=${shellSingleQuote(expectedAddress)}`,
      `gateway=${shellSingleQuote(guestGatewayIp)}`,
      'while [ "$attempt" -le 10 ]; do',
      "  if ip link show dev lo 2>/dev/null | grep -q '[<,]UP[,>]' &&",
      "     ip -4 addr show dev lo 2>/dev/null | grep -F -q '127.0.0.1/8' &&",
      "     ip link show dev \"$interface\" 2>/dev/null | grep -q '[<,]UP[,>]' &&",
      "     ip link show dev \"$interface\" 2>/dev/null | grep -q 'state UP' &&",
      '     ip -4 addr show dev "$interface" 2>/dev/null | grep -F -q "$address" &&',
      '     ip route show default 2>/dev/null | grep -F -q "default via $gateway dev $interface"; then',
      '    exit 0',
      '  fi',
      '  [ "$attempt" -eq 10 ] && break',
      '  sleep "$delay"',
      '  attempt=$((attempt + 1))',
      '  [ "$delay" -ge 8 ] || delay=$((delay * 2))',
      'done',
      'echo "guest data-plane readiness exhausted after $attempt attempts" >&2',
      'ip addr show >&2 || true',
      'echo --- >&2',
      'ip route show >&2 || true',
      'exit 1',
    ].join('\n');
    const stderrCollector = createBoundedOutputCollector();
    try {
      const result = await manager.execute({
        requestId: `probe-network-ready-${process.pid}-${Date.now()}`,
        argv: ['/bin/sh', '-c', script],
        env: environment,
        cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
        ...identity,
        timeoutMs: CLOUD_HYPERVISOR_GUEST_NETWORK_READY_TIMEOUT_MS,
        stderr: stderrCollector.stream,
      });
      if (result.exitCode === 0) return;
      throw new Error(
        `data-plane readiness check exited with code ${result.exitCode}` +
        (stderrCollector.toString().trim()
          ? ` (${stderrCollector.toString().trim()})`
          : ''),
      );
    } catch (error) {
      throw new CloudHypervisorRetryableReadinessError(
        'guest-network-readiness',
        bootAttempt,
        `guest-network-not-ready: expected lo UP with 127.0.0.1/8, ` +
          `${guestInterfaceName} state UP with ${expectedAddress}, and default route via ` +
          `${guestGatewayIp} (${formatError(error)})`,
        error,
      );
    }
  }

  private async cleanupFailedBootAttempt(
    bootAttempt: number,
    startupError: unknown,
    finalAttempt: boolean,
  ): Promise<void> {
    const manager = this.manager;
    if (!manager) return;
    const diagnosticsDirectory = this.getBootDiagnosticsDirectory(bootAttempt);
    const collectPreCleanupDiagnostics = async (): Promise<void> => {
      try {
        await manager.collectDiagnostics(diagnosticsDirectory);
        this.failedBootDiagnostics.push(diagnosticsDirectory);
        if (finalAttempt) this.diagnosticsCollected = true;
      } catch (diagnosticsError) {
        this.dependencies.logger.warn(
          `[cloud-hypervisor] failed to collect boot-attempt diagnostics ` +
          `attempt=${bootAttempt}: ${formatError(diagnosticsError)}`,
        );
      }
    };
    try {
      await manager.stop({ beforeCleanup: collectPreCleanupDiagnostics });
      this.manager = undefined;
      this.environment = undefined;
    } catch (cleanupError) {
      const combined = new Error(
        `Cloud Hypervisor startup failed: ${formatError(startupError)}; ` +
        `microVM cleanup also failed: ${formatError(cleanupError)}`,
      );
      Object.defineProperty(combined, 'cause', { value: startupError });
      Object.assign(combined, { cleanupCause: cleanupError });
      throw combined;
    }
  }

  private getBootDiagnosticsDirectory(bootAttempt: number): string {
    const root = this.config.auditDir
      ? `${this.config.auditDir}/cloud-hypervisor`
      : `${this.config.workDir}/diagnostics/cloud-hypervisor`;
    return `${root}/boot-attempt-${bootAttempt}`;
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

export function createCloudHypervisorRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): ExternalAgentRuntimeBackend {
  return new CloudHypervisorRuntimeBackend(config, defaultDependencies(startInfrastructure));
}
