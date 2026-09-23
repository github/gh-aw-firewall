import { randomBytes } from 'crypto';
import type { WorkflowDependencies } from '../cli-workflow';
import type { ExternalAgentRuntimeBackend } from '../external-runtime-backend';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { logger } from '../logger';
import {
  resolveMicrovmInfrastructure,
  type MicrovmInfrastructureSnapshot,
} from '../microvm/infrastructure';
import { createMicrovmNetworkPlan, type MicrovmControlPeer } from '../microvm/network';
import { buildGuestEnvironment } from '../microvm/guest-environment';
import { NETWORK_SUBNET } from '../config/network-policy';
import { MCP_GATEWAY_PORT } from '../cloud-hypervisor/backend-utils';
import type { WrapperConfig } from '../types';
import {
  NvxManager,
  NVX_ARTIFACT_RELEASE_TAG,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  type NvxOneShotExecutionResult,
} from '../nvx';
import { resolveTrustedNvxHostTool } from './preflight';
import { assertNvxRuntimeCompatibility, requireNvxConfig } from './runtime-validation';

const NVX_GUEST_WORKSPACE = '/workspace';
const NVX_GUEST_HOME = `${NVX_GUEST_WORKSPACE}/.awf-home`;
const NVX_MAX_TIMEOUT_MS = 86_400_000;

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export interface NvxRuntimeBackendDependencies {
  startInfrastructure: WorkflowDependencies['startContainers'];
  resolveTrustedIpTool(): Promise<string>;
  resolveInfrastructure(
    enableApiProxy: boolean,
    ipPath?: string,
    topologyPeerNames?: readonly string[],
  ): Promise<MicrovmInfrastructureSnapshot>;
  createManager(config: ConstructorParameters<typeof NvxManager>[0]): NvxManager;
  identity(): { uid: number; gid: number };
  randomRunId(): string;
  logger: {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): NvxRuntimeBackendDependencies {
  return {
    startInfrastructure,
    resolveTrustedIpTool: () => resolveTrustedNvxHostTool('ip'),
    resolveInfrastructure: (enableApiProxy, ipPath, topologyPeerNames) =>
      resolveMicrovmInfrastructure(enableApiProxy, undefined, ipPath, topologyPeerNames),
    createManager: (config) => new NvxManager(config),
    identity: () => ({
      uid: Number(getSafeHostUid()),
      gid: Number(getSafeHostGid()),
    }),
    randomRunId: () => randomBytes(16).toString('hex'),
    logger,
  };
}

function createBackendWithDependencies(
  config: WrapperConfig,
  dependencies: NvxRuntimeBackendDependencies,
): ExternalAgentRuntimeBackend {
  return new NvxRuntimeBackend(config, dependencies);
}

/** @internal Exposed only for focused default-policy tests. */
// ts-prune-ignore-next
export const nvxRuntimeTestHelpers = {
  defaultDependencies,
  createBackendWithDependencies,
};

/**
 * Stateful adapter for the explicitly enabled, fail-closed NVX one-shot
 * preview microVM runtime.
 *
 * `NvxManager.execute()` is atomic: it performs preflight, launch, workload
 * execution, and durable cleanup in a single call. This adapter therefore
 * only brings up host infrastructure (Squid/api-proxy) in `start()`, and
 * defers the actual microVM lifecycle to `exec()`. There is no persistent
 * "ready" microVM to `stop()` between `start()` and `exec()`.
 *
 * Known limitation: unlike the Docker/Cloud Hypervisor backends, the
 * underlying NVX one-shot adapter (`src/nvx/one-shot-adapter.ts`) does not
 * accept arbitrary per-run guest environment variables — only an
 * `entrypoint`, `args`, and network egress rules. `--env`/`--env-all`/
 * `--env-file` values are therefore not delivered to the NVX guest process;
 * any environment the agent command requires (including proxy settings)
 * must be pre-configured in the guest layer supplied via `--nvx-layer`.
 *
 * Production code must go through {@link createNvxRuntimeBackend} instead of
 * constructing this class directly.
 */
// ts-prune-ignore-next
export class NvxRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = 'nvx';

  private infrastructure: MicrovmInfrastructureSnapshot | undefined;
  private identity: { uid: number; gid: number } | undefined;
  private abortController: AbortController | undefined;
  private activeExecution: Promise<NvxOneShotExecutionResult> | undefined;
  private stopped = false;

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: NvxRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    const nvx = requireNvxConfig(this.config);
    if (
      this.config.agentTimeout !== undefined &&
      this.config.agentTimeout * 60_000 > NVX_MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `NVX preview supports --agent-timeout values up to ${
          NVX_MAX_TIMEOUT_MS / 60_000
        } minutes`,
      );
    }
    // Re-runs the full compatibility guard (not just the preview flag and
    // host eligibility) here, immediately before infrastructure startup,
    // because main-action.ts's automatic split-filesystem probe can mutate
    // `config.dockerHostPathPrefix` after the config was first assembled.
    // Without this, an auto-detected ARC/DinD configuration that NVX
    // explicitly rejects could slip through undetected.
    assertNvxRuntimeCompatibility(this.config, nvx);
  }

  readonly start: WorkflowDependencies['startContainers'] = async (
    workDir,
    allowedDomains,
    proxyLogsDir,
    skipPull,
    onNetworkReady,
    onInfrastructureReady,
  ) => {
    await this.preflight();
    await this.dependencies.startInfrastructure(
      workDir,
      allowedDomains,
      proxyLogsDir,
      skipPull,
      onNetworkReady,
      onInfrastructureReady,
    );
    if (this.stopped) {
      throw new Error('NVX microVM infrastructure startup aborted by shutdown');
    }
    // Resolve the `ip` binary through the same trusted-tool preflight NVX
    // uses for everything else before it is invoked for root-side
    // infrastructure discovery, rather than letting `execa` fall through to
    // an ambient, untrusted PATH lookup.
    const ipPath = await this.dependencies.resolveTrustedIpTool();
    this.infrastructure = await this.dependencies.resolveInfrastructure(
      Boolean(this.config.enableApiProxy),
      ipPath,
      this.config.topologyAttach,
    );
    this.identity = this.dependencies.identity();
  };

  readonly exec: WorkflowDependencies['runAgentCommand'] = async (
    _workDir,
    _allowedDomains,
    _proxyLogsDir,
    agentTimeoutMinutes,
  ) => {
    if (this.stopped) {
      throw new Error('NVX microVM execution aborted by shutdown');
    }
    const nvx = requireNvxConfig(this.config);
    const infrastructure = this.infrastructure;
    const identity = this.identity;
    if (!infrastructure || !identity) {
      throw new Error('NVX microVM infrastructure is not ready');
    }
    if (this.config.tty) {
      throw new Error('NVX preview guest does not support TTY execution');
    }

    // Prove the discovered bridge/service topology is still the one in
    // effect immediately before handing control to the manager, so a
    // Docker network or bridge changed between infrastructure discovery
    // and launch cannot cause NVX to attach using stale identities.
    await infrastructure.revalidate();
    if (this.stopped) {
      throw new Error('NVX microVM execution aborted by shutdown');
    }

    const runId = this.dependencies.randomRunId();
    const networkPlan = createMicrovmNetworkPlan(runId, {
      infrastructureBridge: infrastructure.bridgeName,
      enableApiProxy: Boolean(infrastructure.apiProxyIp),
      tapOwnerUid: identity.uid,
      tapOwnerGid: identity.gid,
    });
    logNvxGuestEnvironment(
      buildGuestEnvironment({
        config: this.config,
        networkConfig: {
          subnet: NETWORK_SUBNET,
          squidIp: infrastructure.squidIp,
          agentIp: networkPlan.guestIp,
          proxyIp: infrastructure.apiProxyIp,
        },
        home: NVX_GUEST_HOME,
        workspace: NVX_GUEST_WORKSPACE,
        runtimeName: 'nvx',
        runtimeDisplayName: 'NVX',
      }),
      this.dependencies.logger,
    );

    const abortController = new AbortController();
    this.abortController = abortController;
    const timeoutMs = agentTimeoutMinutes === undefined
      ? undefined
      : agentTimeoutMinutes * 60_000;

    const manager = this.dependencies.createManager({
      runId,
      preflight: {
        runId,
        expectedReleaseTag: NVX_ARTIFACT_RELEASE_TAG,
        expectedSignerWorkflow: nvx.signerWorkflow ?? NVX_ARTIFACT_SIGNER_WORKFLOW,
        manifestPath: nvx.artifactManifestPath!,
        artifactManifestBundlePath: nvx.artifactManifestBundlePath!,
        artifacts: {
          openvmm: nvx.openvmmPath!,
          kernel: nvx.kernelPath!,
          initramfs: nvx.initramfsPath!,
        },
      },
      filesystem: {
        workDir: this.config.workDir ?? '/run/awf-nvx',
        layers: [{ role: 'distro', sourcePath: nvx.layerPath! }],
        scratchBytes: nvx.scratchBytes,
        scratchUid: identity.uid,
        scratchGid: identity.gid,
      },
      execution: {
        entrypoint: '/bin/sh',
        args: ['-lc', this.config.agentCommand],
        workloadUid: identity.uid,
        workloadGid: identity.gid,
        memoryMib: nvx.memoryMib,
        memoryMaxBytes: nvx.memoryMaxBytes,
        pidsMax: nvx.pidsMax,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        abortSignal: abortController.signal,
        stdout: process.stdout,
        stderr: process.stderr,
      },
      network: {
        infrastructureBridge: infrastructure.bridgeName,
        enableApiProxy: Boolean(infrastructure.apiProxyIp),
        controlPeers: buildNvxControlPeers(infrastructure.topologyPeerIps),
      },
    });

    const execution = manager.execute();
    this.activeExecution = execution;
    try {
      const result = await execution;
      this.dependencies.logger.info(
        `[nvx] Agent command exited with code ${result.exitCode}` +
        (result.signal ? ` (${result.signal})` : ''),
      );
      return { exitCode: result.exitCode };
    } finally {
      this.activeExecution = undefined;
      this.abortController = undefined;
    }
  };

  async collectDiagnostics(): Promise<void> {
    // NvxManager tears down all per-run diagnostics-bearing state (network
    // namespace, cgroup, run directory) as part of its own atomic
    // execute()/cleanup() before returning, so there is no separate
    // diagnostics snapshot for this adapter to collect after the fact.
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController?.abort();
    if (this.activeExecution) {
      await this.activeExecution.catch(() => undefined);
    }
  }
}

function buildNvxControlPeers(
  topologyPeerIps: Readonly<Record<string, string>>,
): readonly MicrovmControlPeer[] {
  return Object.values(topologyPeerIps).map((ip) => ({
    ip,
    ports: [MCP_GATEWAY_PORT],
  }));
}

function logNvxGuestEnvironment(
  environment: Record<string, string>,
  log: NvxRuntimeBackendDependencies['logger'],
): void {
  log.debug(
    `[nvx-env] HOME=${environment.HOME} ****** ` +
    `SQUID_PROXY_HOST=${environment.SQUID_PROXY_HOST ?? '(unset)'}`,
  );
}

export function createNvxRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): ExternalAgentRuntimeBackend {
  return new NvxRuntimeBackend(config, defaultDependencies(startInfrastructure));
}
