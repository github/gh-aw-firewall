import type { Readable, Writable } from 'stream';
import { promises as fs } from 'fs';
import type { WorkflowDependencies } from '../cli-workflow';
import type { ExternalAgentRuntimeBackend } from '../external-runtime-backend';
import {
  resolveMicrovmInfrastructure,
  type MicrovmInfrastructureSnapshot,
} from '../microvm/infrastructure';
import type {
  GuestExecutionRequest,
  GuestExecutionResult,
} from '../microvm/vsock-client';
import type { CloudHypervisorPreflightResult } from './preflight';
import { CloudHypervisorManager } from './manager';
import {
  runCloudHypervisorPreflight,
} from './preflight';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { logger } from '../logger';
import type { CloudHypervisorOptions, WrapperConfig } from '../types';
import {
  assertCloudHypervisorRuntimeCompatibility,
  requireCloudHypervisorConfig,
} from './runtime-validation';
import {
  resolveCloudHypervisorExports,
  type CloudHypervisorDirectoryExport,
} from './exports';
import type { VirtiofsdMountEnforcement } from './virtiofsd';
import { buildCloudHypervisorGuestEnvironment } from './guest-environment-builder';
import {
  CLOUD_HYPERVISOR_GUEST_WORKSPACE,
  MCP_GATEWAY_PORT,
  formatError,
} from './backend-utils';
import { runCloudHypervisorBootLoop } from './runtime-boot-loop';
import {
  cleanupArtifactSnapshot,
  getDiagnosticsRoot,
  stopManager,
} from './runtime-cleanup';
import { createPrimaryAgentCloudHypervisorProfile } from './workload-profile';
export { buildCloudHypervisorGuestEnvironment };
export { CloudHypervisorRetryableReadinessError } from './preflight';
export {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
} from './runtime-validation';

const CLOUD_HYPERVISOR_MAX_TIMEOUT_MS = 86_400_000;

export interface CloudHypervisorBackendLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface CloudHypervisorManagerAdapter {
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
  collectGuestOutputAudit(directory: string): Promise<void>;
  completeCleanupRecord(): Promise<void>;
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
    mountEnforcement: VirtiofsdMountEnforcement | undefined,
    verifiedArtifacts: CloudHypervisorPreflightResult,
  ): CloudHypervisorManagerAdapter;
  resolveExports(mountPolicy: CloudHypervisorOptions['mountPolicy']): Promise<CloudHypervisorDirectoryExport[]>;
  identity(): { uid: number; gid: number };
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  logger: CloudHypervisorBackendLogger;
  sleep(milliseconds: number): Promise<void>;
  removeArtifactSnapshot(directory: string): Promise<void>;
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): CloudHypervisorRuntimeBackendDependencies {
  return {
    startInfrastructure,
    preflight: runCloudHypervisorPreflight,
    resolveInfrastructure: (enableApiProxy, ipPath, topologyPeerNames) =>
      resolveMicrovmInfrastructure(enableApiProxy, undefined, ipPath, topologyPeerNames),
    createManager: (
      config,
      workDir,
      infrastructure,
      exports,
      identity,
      mountEnforcement,
      verifiedArtifacts,
    ) =>
      new CloudHypervisorManager(
        config,
        workDir,
        undefined,
        undefined,
        createPrimaryAgentCloudHypervisorProfile({
          network: {
            infrastructureBridge: infrastructure.bridgeName,
            enableApiProxy: Boolean(infrastructure.apiProxyIp),
            ...(infrastructure.apiProxyIp ? { apiProxyIp: infrastructure.apiProxyIp } : {}),
            controlPeers: Object.values(infrastructure.topologyPeerIps).map((ip) => ({
              ip,
              ports: [MCP_GATEWAY_PORT],
            })),
            hostAliases: infrastructure.topologyPeerIps,
          },
          guest: {
            exports,
            ...(mountEnforcement ? { mountEnforcement } : {}),
            supervisorBinaryPath: config.supervisorPath!,
            supervisorSha256: config.sha256!.supervisor!,
            identity,
            workspaceMount: '/workspace',
          },
        }),
        undefined,
        verifiedArtifacts,
      ),
    resolveExports: (mountPolicy) => resolveCloudHypervisorExports(
      process.env,
      process.cwd(),
      mountPolicy,
    ),
    identity: () => ({
      uid: Number(getSafeHostUid()),
      gid: Number(getSafeHostGid()),
    }),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    logger,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    removeArtifactSnapshot: async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    },
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
  private diagnosticsCollected = false;
  private agentExecutionStarted = false;
  private readonly failedBootDiagnostics: string[] = [];
  private readonly cleanedManagers = new Set<CloudHypervisorManagerAdapter>();
  private readonly stoppedManagers = new WeakSet<CloudHypervisorManagerAdapter>();

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: CloudHypervisorRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    if (this.preflightResult) return;
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
    const boot = await runCloudHypervisorBootLoop({
      config: this.config,
      workDir,
      allowedDomains,
      proxyLogsDir,
      skipPull,
      onNetworkReady,
      onInfrastructureReady,
      dependencies: this.dependencies,
      ensurePreflight: () => this.preflight(),
      getPreflightResult: () => this.preflightResult,
      cleanupArtifactSnapshot: () => this.cleanupArtifactSnapshot(),
      agentExecutionStarted: () => this.agentExecutionStarted,
      publishManager: (manager) => {
        this.manager = manager;
      },
      isStopped: () => this.stopped || this.stopping !== undefined,
      markStopped: () => {
        this.stopped = true;
      },
      markDiagnosticsCollected: () => {
        this.diagnosticsCollected = true;
      },
      failedBootDiagnostics: this.failedBootDiagnostics,
      cleanedManagers: this.cleanedManagers,
    });
    this.manager = boot.manager;
    this.environment = boot.environment;
    this.identity = boot.identity;
    if (boot.diagnosticsCollected) this.diagnosticsCollected = true;
    // A stop()/preserve() can race with the tail of boot (the signal handler
    // calls stop() while start() is still awaiting readiness probes). If that
    // happened, the microVM this attempt just booted is not covered by the
    // in-flight teardown, so tear it down here rather than returning a
    // "ready" runtime backed by orphaned VMM/virtiofsd processes.
    if (this.stopped || this.stopping) {
      await this.stopping?.catch(() => undefined);
      if (!this.stoppedManagers.has(boot.manager)) {
        await this.stopManager(false);
      }
      this.stopped = true;
      this.manager = undefined;
      this.environment = undefined;
      throw new Error('Cloud Hypervisor microVM startup aborted by shutdown');
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
      filterWorkflowCommands: true,
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
      if (this.config.auditDir) {
        await manager.collectGuestOutputAudit(`${this.config.auditDir}/cloud-hypervisor`);
      }
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
    const directory = getDiagnosticsRoot(this.config);
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
        if (this.preflightResult?.artifactSnapshotDirectory) {
          this.dependencies.logger.info(
            `[cloud-hypervisor] Preserved trusted artifacts: ${
              this.preflightResult.artifactSnapshotDirectory
            }`,
          );
        }
      }
    } finally {
      this.stopping = undefined;
    }
  }

  private async stopManager(preserve: boolean): Promise<void> {
    if (this.manager) this.stoppedManagers.add(this.manager);
    await stopManager({
      activeExecution: this.activeExecution,
      manager: this.manager,
      preserve,
      cleanedManagers: this.cleanedManagers,
      cleanupArtifactSnapshot: () => this.cleanupArtifactSnapshot(),
    });
  }

  private async cleanupArtifactSnapshot(): Promise<void> {
    const cleared = await cleanupArtifactSnapshot({
      preflightResult: this.preflightResult,
      manager: this.manager,
      cleanedManagers: this.cleanedManagers,
      removeArtifactSnapshot: this.dependencies.removeArtifactSnapshot,
    });
    if (cleared) this.preflightResult = undefined;
  }

}

export function createCloudHypervisorRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): ExternalAgentRuntimeBackend {
  return new CloudHypervisorRuntimeBackend(config, defaultDependencies(startInfrastructure));
}
