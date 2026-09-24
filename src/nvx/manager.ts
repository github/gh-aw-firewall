import { constants, promises as fs } from 'fs';
import * as path from 'path';
import {
  LinuxNetworkCommands,
  MicrovmNetworkManager,
  reserveMicrovmNetworkPlan,
  type MicrovmControlPeer,
  type MicrovmNetworkLifecycle,
  type MicrovmNetworkPlanOptions,
  type MicrovmNetworkReservation,
} from '../microvm/network';
import {
  DurableNvxCleanupRegistry,
  type NvxCleanupHandle,
  type NvxCleanupRegistry,
} from './cleanup-registry';
import {
  verifyNvxConfinement,
  type NvxConfinementEvidence,
} from './confinement';
import {
  NvxFilesystemBuilder,
  type NvxFilesystemBuilderConfig,
  type NvxFilesystemBundle,
} from './filesystem-builder';
import {
  type NvxOneShotExecutionRequest,
  type NvxOneShotExecutionResult,
} from './one-shot-adapter';
import {
  runNvxPreflight,
  type NvxPreflightHooks,
  type NvxPreflightOptions,
  type NvxPreflightResult,
} from './preflight';
import {
  NvxCgroupManager,
  NvxVmmIdentityManager,
  bindNvxNetworkPlan,
  buildNvxPhase3dLaunchPlan,
  type NvxPhase3dLaunchPlan,
  type NvxRuntimeToolPaths,
  type NvxVmmIdentity,
} from './runtime-lifecycle';
import { DirectOpenvmmLaunchExecutor } from './launch-executor';
import type { NvxWorkspaceCopyBackResult } from './workspace-layer';
import { logger } from '../logger';

/**
 * Host-side lifecycle of the AWF-owned `custom` guest layer that exports the
 * host workspace into the microVM. Structurally satisfied by
 * {@link import('./workspace-layer').NvxWorkspaceLayer}; kept as an interface
 * so the manager stays unit-testable without touching the filesystem.
 */
export interface NvxWorkspaceLifecycle {
  /** Stages the layer source tree and returns its host path. */
  stage(): Promise<string>;
  /** Merges the guest overlay upper layer back into the host workspace. */
  extractAfterStop(scratchImagePath: string): Promise<NvxWorkspaceCopyBackResult>;
  cleanup(): Promise<void>;
}

export interface NvxLaunchHooks {
  launcherStarted(pid: number): Promise<void>;
  sandboxStarted(pid: number): Promise<void>;
  openvmmReady(pid: number, mountNamespaceInode: string): Promise<void>;
}

export interface NvxLaunchExecutor {
  execute(options: {
    readonly plan: NvxPhase3dLaunchPlan;
    readonly request: NvxOneShotExecutionRequest;
    readonly hooks: NvxLaunchHooks;
  }): Promise<NvxOneShotExecutionResult>;
  terminate?(): Promise<void>;
}

export interface NvxManagerConfig {
  readonly runId: string;
  readonly preflight: NvxPreflightOptions;
  readonly filesystem: Omit<NvxFilesystemBuilderConfig, 'runId' | 'useCanonicalRunDirectory'>;
  readonly execution: Omit<NvxOneShotExecutionRequest, 'nvxRoot' | 'filesystem' | 'network'>;
  readonly network: {
    readonly infrastructureBridge: string;
    readonly enableApiProxy: boolean;
    readonly controlPeers?: readonly MicrovmControlPeer[];
  };
  /**
   * Optional live host workspace export. When present it is staged as the
   * guest's `custom` layer before the filesystem bundle is built, and the
   * guest's writes are copied back after the microVM has exited but before the
   * run directory (and with it the scratch image) is removed.
   */
  readonly workspace?: NvxWorkspaceLifecycle;
}

export interface NvxManagerDependencies {
  preflight(
    options: NvxPreflightOptions,
    hooks: NvxPreflightHooks,
  ): Promise<NvxPreflightResult>;
  cleanupRegistry: NvxCleanupRegistry;
  createIdentity(
    runId: string,
    tools: NvxRuntimeToolPaths,
    observer: {
      prepareAccount(name: string): Promise<void>;
      captureIdentity(identity: NvxVmmIdentity): Promise<void>;
      prepareDeviceAcl(identity: import('./cleanup-record').NvxCleanupDeviceAclIdentity): Promise<void>;
      releaseDeviceAcl(identity: import('./cleanup-record').NvxCleanupDeviceAclIdentity): Promise<void>;
    },
  ): NvxVmmIdentityManager;
  createFilesystem(config: NvxFilesystemBuilderConfig): NvxFilesystemBuilder;
  reserveNetwork(
    runId: string,
    options: MicrovmNetworkPlanOptions,
    tools: NvxRuntimeToolPaths,
  ): Promise<MicrovmNetworkReservation>;
  createNetwork(
    plan: NvxPhase3dLaunchPlan['networkPlan'],
    tools: NvxRuntimeToolPaths,
    reservation: MicrovmNetworkReservation,
    observer: { resourceCreated(resource: 'netns' | 'hostVeth' | 'namespaceVeth' | 'tap'): Promise<void> },
  ): MicrovmNetworkLifecycle;
  createCgroup(path: string, limits: NvxPhase3dLaunchPlan['cgroupLimits']): NvxCgroupManager;
  launchExecutor: NvxLaunchExecutor;
  verifyConfinement: typeof verifyNvxConfinement;
  copyFile: typeof fs.copyFile;
  chmod: typeof fs.chmod;
  chown: typeof fs.chown;
  rm: typeof fs.rm;
}

export function createDefaultNvxManagerDependencies(): NvxManagerDependencies {
  return {
    preflight: (options, hooks) => runNvxPreflight(options, undefined, hooks),
    cleanupRegistry: new DurableNvxCleanupRegistry(),
    createIdentity: (runId, tools, observer) =>
      new NvxVmmIdentityManager(runId, tools, undefined, observer),
    createFilesystem: (config) => new NvxFilesystemBuilder(config),
    reserveNetwork: (runId, options, tools) => reserveMicrovmNetworkPlan(
      runId,
      options,
      tools,
      (plan) => bindNvxNetworkPlan(runId, plan),
    ),
    createNetwork: (plan, tools, reservation, observer) => new MicrovmNetworkManager(
      plan,
      new LinuxNetworkCommands(undefined, tools),
      undefined,
      reservation,
      observer,
    ),
    createCgroup: (cgroupPath, limits) => new NvxCgroupManager(cgroupPath, limits),
    launchExecutor: new DirectOpenvmmLaunchExecutor(),
    verifyConfinement: verifyNvxConfinement,
    copyFile: fs.copyFile,
    chmod: fs.chmod,
    chown: fs.chown,
    rm: fs.rm,
  };
}

export class NvxManager {
  private cleanupHandle: NvxCleanupHandle | undefined;
  private preflightResult: NvxPreflightResult | undefined;
  private identityManager: NvxVmmIdentityManager | undefined;
  private filesystemBuilder: NvxFilesystemBuilder | undefined;
  private networkReservation: MicrovmNetworkReservation | undefined;
  private network: MicrovmNetworkLifecycle | undefined;
  private cgroup: NvxCgroupManager | undefined;
  private launchPlan: NvxPhase3dLaunchPlan | undefined;
  private scratchImagePath: string | undefined;
  private launcherPid: number | undefined;
  private sandboxPid: number | undefined;
  private openvmmPid: number | undefined;
  private confinementEvidence: NvxConfinementEvidence | undefined;
  private workspaceCopyBack: NvxWorkspaceCopyBackResult | undefined;

  constructor(
    private readonly config: NvxManagerConfig,
    private readonly dependencies: NvxManagerDependencies =
      createDefaultNvxManagerDependencies(),
  ) {}

  async execute(): Promise<NvxOneShotExecutionResult> {
    if (this.config.preflight.runId !== this.config.runId) {
      throw new Error('NVX manager and preflight must use the same run ID');
    }
    let executionResult: NvxOneShotExecutionResult | undefined;
    let executionError: unknown;
    try {
      this.preflightResult = await this.dependencies.preflight(
        this.config.preflight,
        {
          beforeSnapshot: async (tools) => {
            await this.dependencies.cleanupRegistry.reapPending(toCleanupTools(tools));
            this.cleanupHandle = await this.dependencies.cleanupRegistry.createPending(
              this.config.runId,
              tools.ip,
            );
          },
          snapshotCreated: async (snapshot) => {
            await this.requireCleanupHandle().captureArtifactSnapshot(snapshot.directory);
          },
        },
      );
      const tools = toRuntimeTools(this.preflightResult.tools);
      const cleanupHandle = this.requireCleanupHandle();
      this.identityManager = this.dependencies.createIdentity(
        this.config.runId,
        tools,
        {
          prepareAccount: (name) => cleanupHandle.prepareAccount(name),
          captureIdentity: (identity) => cleanupHandle.captureIdentity(identity),
          prepareDeviceAcl: (identity) => cleanupHandle.prepareDeviceAcl(identity),
          releaseDeviceAcl: (identity) => cleanupHandle.releaseDeviceAcl(identity),
        },
      );
      const identity = await this.identityManager.allocate();
      this.networkReservation = await this.dependencies.reserveNetwork(this.config.runId, {
        infrastructureBridge: this.config.network.infrastructureBridge,
        enableApiProxy: this.config.network.enableApiProxy,
        tapOwnerUid: identity.uid,
        tapOwnerGid: identity.gid,
        createTap: false,
        controlPeers: this.config.network.controlPeers,
      }, tools);
      const networkPlan = this.networkReservation.plan;
      await cleanupHandle.captureNetworkPlan(networkPlan);
      this.network = this.dependencies.createNetwork(
        networkPlan,
        tools,
        this.networkReservation,
        {
        resourceCreated: (resource) => cleanupHandle.captureNetworkResource(resource),
        },
      );
      await this.network.setup();
      const workspaceLayerSource = await this.config.workspace?.stage();
      this.filesystemBuilder = this.dependencies.createFilesystem({
        ...this.config.filesystem,
        layers: [
          ...this.config.filesystem.layers,
          ...(workspaceLayerSource === undefined
            ? []
            : [{
              role: 'custom' as const,
              sourcePath: workspaceLayerSource,
              preserveOwnership: true,
            }]),
        ],
        runId: this.config.runId,
        useCanonicalRunDirectory: true,
      });
      const filesystem = await this.filesystemBuilder.prepare();
      this.scratchImagePath = filesystem.scratch.path;
      const resolverConfigPath = path.join(filesystem.runDirectory, 'resolv.conf');
      await this.dependencies.copyFile(
        '/etc/resolv.conf',
        resolverConfigPath,
        constants.COPYFILE_EXCL,
      );
      await this.dependencies.chmod(resolverConfigPath, 0o444);
      await this.dependencies.chown(filesystem.runDirectory, identity.uid, identity.gid);
      await this.dependencies.chown(resolverConfigPath, identity.uid, identity.gid);
      await this.dependencies.chown(filesystem.manifestPath, identity.uid, identity.gid);
      for (const layer of filesystem.layers) {
        await this.dependencies.chown(layer.path, identity.uid, identity.gid);
      }
      await this.dependencies.chown(filesystem.scratch.path, identity.uid, identity.gid);
      await cleanupHandle.captureRunDirectory();
      this.launchPlan = buildNvxPhase3dLaunchPlan({
        runId: this.config.runId,
        tools,
        identity,
        filesystem,
        execution: this.config.execution,
        network: this.config.network,
        networkPlan,
      });
      this.cgroup = this.dependencies.createCgroup(
        this.launchPlan.layout.cgroupPath,
        this.launchPlan.cgroupLimits,
      );
      await this.cgroup.setup();
      await cleanupHandle.captureCgroup();

      executionResult = await this.identityManager.withDeviceAccess(() =>
        this.dependencies.launchExecutor.execute({
          plan: this.launchPlan!,
          request: createExecutionRequest(
            this.config.execution,
            this.preflightResult!,
            filesystem,
            this.launchPlan!,
          ),
          hooks: {
            launcherStarted: async (pid) => {
              this.launcherPid = pid;
              await cleanupHandle.captureProcess('launcher', pid);
            },
            sandboxStarted: async (pid) => {
              if (this.launcherPid === undefined) {
                throw new Error('NVX sandbox started before its launcher was recorded');
              }
              this.sandboxPid = pid;
              await this.cgroup!.assignProcessTree([this.launcherPid, pid]);
            },
            openvmmReady: async (pid, mountNamespaceInode) => {
              if (this.launcherPid === undefined || this.sandboxPid === undefined) {
                throw new Error('NVX OpenVMM became ready before its launch processes were recorded');
              }
              this.openvmmPid = pid;
              await this.cgroup!.assignProcessTree([this.launcherPid, this.sandboxPid, pid]);
              await cleanupHandle.captureProcess('openvmm', pid);
              await cleanupHandle.captureMountNamespace(mountNamespaceInode);
              this.confinementEvidence = await this.dependencies.verifyConfinement({
                openvmmPid: pid,
                expectedOpenvmmExecutable: this.preflightResult!.snapshot.openvmm,
                expectedCgroupPids: [this.launcherPid, this.sandboxPid, pid],
                identity,
                launchPolicy: this.launchPlan!.launchCommand.confinementPolicy,
                networkNamespace: this.launchPlan!.networkPlan.namespaceName,
                expectedMountNamespaceInode: mountNamespaceInode,
                cgroupPath: this.launchPlan!.layout.cgroupPath,
                cgroupLimits: this.launchPlan!.cgroupLimits,
              });
            },
          },
        }),
      );
      if (
        this.launcherPid === undefined ||
        this.openvmmPid === undefined ||
        this.confinementEvidence === undefined
      ) {
        throw new Error(
          'NVX launch executor returned before completing the required ' +
          'launcher, OpenVMM readiness, and confinement hooks',
        );
      }
    } catch (error) {
      executionError = error;
    }
    if (this.config.workspace && this.scratchImagePath) {
      try {
        this.workspaceCopyBack = await this.config.workspace.extractAfterStop(
          this.scratchImagePath,
        );
      } catch (error) {
        // A copy-back failure must not be masked by a successful run: the host
        // workspace is an output of the run, so losing it is a run failure.
        if (!executionError) executionError = error;
      }
    } else if (this.config.workspace) {
      // The scratch image never materialized, so there is no overlay upper
      // layer to merge. Surfacing this keeps a silently discarded workspace
      // from looking like a run that simply produced no writes.
      logger.warn(
        'NVX workspace copy-back skipped: the scratch device was never created',
      );
    }
    let cleanupError: unknown;
    try {
      await this.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (executionError && cleanupError) {
      throw new Error(
        `NVX execution failed: ${formatError(executionError)}; cleanup also failed: ` +
        formatError(cleanupError),
      );
    }
    if (executionError) throw executionError;
    if (cleanupError) throw cleanupError;
    if (!executionResult) {
      throw new Error('NVX execution completed without a result');
    }
    return executionResult;
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: (() => Promise<unknown>) | undefined): Promise<void> => {
      if (!operation) return;
      try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(this.dependencies.launchExecutor.terminate?.bind(this.dependencies.launchExecutor));
    await attempt(this.config.workspace
      ? () => this.config.workspace!.cleanup()
      : undefined);
    await attempt(this.cgroup ? () => this.cgroup!.cleanup() : undefined);
    await attempt(this.filesystemBuilder ? () => this.filesystemBuilder!.cleanup() : undefined);
    await attempt(this.network ? () => this.network!.cleanup() : undefined);
    if (!this.network) {
      await attempt(this.networkReservation
        ? () => this.networkReservation!.release()
        : undefined);
    }
    await attempt(this.identityManager ? () => this.identityManager!.cleanup() : undefined);
    await attempt(this.preflightResult
      ? () => this.dependencies.rm(this.preflightResult!.snapshot.directory, {
          recursive: true,
          force: true,
        })
      : undefined);
    if (errors.length === 0) await this.cleanupHandle?.complete();
    if (errors.length > 0) {
      throw new Error(`NVX cleanup failed: ${errors.map(formatError).join('; ')}`);
    }
  }

  getConfinementEvidence(): NvxConfinementEvidence | undefined {
    return this.confinementEvidence;
  }

  getWorkspaceCopyBack(): NvxWorkspaceCopyBackResult | undefined {
    return this.workspaceCopyBack;
  }

  private requireCleanupHandle(): NvxCleanupHandle {
    if (!this.cleanupHandle) throw new Error('NVX durable cleanup record was not created');
    return this.cleanupHandle;
  }
}

function createExecutionRequest(
  execution: NvxManagerConfig['execution'],
  preflight: NvxPreflightResult,
  filesystem: NvxFilesystemBundle,
  plan: NvxPhase3dLaunchPlan,
): NvxOneShotExecutionRequest {
  return {
    ...execution,
    nvxRoot: preflight.snapshot.directory,
    filesystem,
    network: {
      guestAddress: `${plan.networkPlan.guestIp}/${plan.networkPlan.guestPrefixLength}`,
      egressAllow: plan.networkPlan.allowedEndpoints.map(
        ({ ip, port }) => `${ip}/32:tcp:${port}`,
      ),
    },
  };
}

function toRuntimeTools(tools: NvxPreflightResult['tools']): NvxRuntimeToolPaths {
  return {
    bwrap: tools.bwrap,
    flock: tools.flock,
    getfacl: tools.getfacl,
    getent: tools.getent,
    groupdel: tools.groupdel,
    id: tools.id,
    ip: tools.ip,
    iptables: tools.iptables,
    nft: tools.nft,
    setfacl: tools.setfacl,
    setpriv: tools.setpriv,
    sysctl: tools.sysctl,
    useradd: tools.useradd,
    userdel: tools.userdel,
  };
}

function toCleanupTools(tools: NvxPreflightResult['tools']) {
  return {
    getent: tools.getent,
    groupdel: tools.groupdel,
    id: tools.id,
    ip: tools.ip,
    iptables: tools.iptables,
    setfacl: tools.setfacl,
    userdel: tools.userdel,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
