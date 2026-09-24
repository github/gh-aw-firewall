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
import { MCP_GATEWAY_PORT } from '../cloud-hypervisor/backend-utils';
import execa from 'execa';
import type { NvxOptions, WrapperConfig } from '../types';
import {
  NvxManager,
  NVX_ARTIFACT_RELEASE_TAG,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  type NvxOneShotExecutionResult,
} from '../nvx';
import { resolveTrustedNvxHostTool } from './preflight';
import {
  assertNvxRuntimeCompatibility,
  requireNvxConfig,
  resolveNvxGuestWorkDir,
} from './runtime-validation';
import { buildNvxGuestEnvironment } from './guest-environment-builder';
import { buildNvxGuestRunScript } from './guest-entrypoint';
import { planNvxFilesystemWrites } from './filesystem-write-policy';
import { NvxWorkspaceLayer } from './workspace-layer';
import {
  NVX_GUEST_RUN_SCRIPT,
  resolveNvxExports,
  type NvxDirectoryExport,
} from './workspace-export';

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
  resolveExports(mountPolicy: NvxOptions['mountPolicy']): Promise<NvxDirectoryExport[]>;
  createWorkspaceLayer(
    config: ConstructorParameters<typeof NvxWorkspaceLayer>[0],
  ): NvxWorkspaceLayer;
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
    resolveExports: (mountPolicy) => resolveNvxExports(process.env, process.cwd(), mountPolicy),
    createWorkspaceLayer: (config) => new NvxWorkspaceLayer(config, {
      runTool: async (tool, args) => {
        // Resolved through the same trusted-tool preflight NVX uses for every
        // other host binary rather than an ambient PATH lookup.
        const binary = await resolveTrustedNvxHostTool(tool);
        const result = await execa(binary, [...args], {
          reject: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 600_000,
        });
        return { exitCode: result.exitCode ?? 1, stderr: result.stderr ?? '' };
      },
    }),
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
 * The per-run guest environment (including `--env`/`--env-all`/`--env-file`
 * values and proxy settings), the working directory selected by
 * `--container-workdir`, and the agent command are delivered through an
 * AWF-owned guest entrypoint script staged into the `custom` EROFS layer
 * alongside the live host workspace export. The guest command line itself
 * carries only the script path, so no environment value is exposed in the
 * host process table.
 *
 * Production code must go through {@link createNvxRuntimeBackend} instead of
 * constructing this class directly.
 */
// ts-prune-ignore-next
export class NvxRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = 'nvx';

  private infrastructure: MicrovmInfrastructureSnapshot | undefined;
  private identity: { uid: number; gid: number } | undefined;
  private exports: readonly NvxDirectoryExport[] | undefined;
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
    this.exports = await this.dependencies.resolveExports(
      requireNvxConfig(this.config).mountPolicy,
    );
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
    const exports = this.exports ?? await this.dependencies.resolveExports(nvx.mountPolicy);
    const writePlan = await planNvxFilesystemWrites(
      exports,
      this.config.filesystemAllowWrite,
    );
    const environment = buildNvxGuestEnvironment(
      this.config,
      infrastructure,
      networkPlan.guestIp,
      exports,
    );
    logNvxGuestEnvironment(environment, this.dependencies.logger);
    const workspaceLayer = this.dependencies.createWorkspaceLayer({
      runId,
      stagingRoot: `${this.config.workDir ?? '/run/awf-nvx'}/nvx-guest-layer/${runId}`,
      exports,
      writePlan,
      uid: identity.uid,
      gid: identity.gid,
      runScript: buildNvxGuestRunScript({
        environment,
        workingDirectory: resolveNvxGuestWorkDir(this.config.containerWorkDir),
        command: this.config.agentCommand,
      }),
      homePath: process.env.HOME,
    });

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
        // The guest contract accepts a single absolute entrypoint plus
        // whitespace-free `nvx_arg=` tokens only, so the per-run environment,
        // working directory, and agent command are delivered through the
        // AWF-owned guest script staged in the custom layer instead.
        entrypoint: NVX_GUEST_RUN_SCRIPT,
        args: [],
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
      workspace: workspaceLayer,
    });

    const execution = manager.execute();
    this.activeExecution = execution;
    try {
      const result = await execution;
      const copyBack = manager.getWorkspaceCopyBack();
      if (copyBack) {
        this.dependencies.logger.info(
          `[nvx] Workspace copy-back applied ${copyBack.applied.length} path(s) and ` +
          `removed ${copyBack.removed.length}`,
        );
        if (copyBack.rejected.length > 0) {
          this.dependencies.logger.warn(
            `[nvx] filesystem.allowWrite rejected ${copyBack.rejected.length} guest ` +
            `write(s) outside the policy: ${copyBack.rejected.slice(0, 10).join(', ')}`,
          );
        }
      }
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
