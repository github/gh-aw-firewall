import type { Readable, Writable } from 'stream';
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
import type { FirecrackerPreflightResult } from './firecracker/preflight';
import { FirecrackerManager } from './firecracker/manager';
import { runFirecrackerPreflight } from './firecracker/preflight';
import { getRealUserHome, getSafeHostGid, getSafeHostUid } from './host-identity';
import { logger } from './logger';
import { buildAgentEnvironment } from './services/agent-service';
import { buildAgentCredentialEnv } from './services/api-proxy-credential-env';
import type { FirecrackerOptions, WrapperConfig } from './types';
import {
  assertFirecrackerRuntimeCompatibility,
  requireFirecrackerConfig,
} from './firecracker/runtime-validation';
export {
  assertFirecrackerPreSecurityCompatibility,
  assertFirecrackerRuntimeCompatibility,
} from './firecracker/runtime-validation';

const FIRECRACKER_GUEST_WORKSPACE = '/workspace';
const FIRECRACKER_GUEST_HOME = `${FIRECRACKER_GUEST_WORKSPACE}/.awf-home`;
const FIRECRACKER_PROBE_TIMEOUT_MS = 15_000;
const FIRECRACKER_CANCEL_GRACE_MS = 3_000;
const FIRECRACKER_MAX_TIMEOUT_MS = 86_400_000;

interface FirecrackerBackendLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface FirecrackerManagerAdapter {
  readonly paths: Pick<FirecrackerManager['paths'], 'jailRoot'>;
  readonly guestIp?: string;
  readonly networkNamespace?: string;
  start(): Promise<unknown>;
  startInstance(): Promise<void>;
  execute(request: GuestExecutionRequest): Promise<GuestExecutionResult>;
  cancel(reason?: string, requestId?: string): Promise<void>;
  writeStdin(data: Buffer, requestId?: string): Promise<void>;
  endStdin(requestId?: string): Promise<void>;
  stop(options?: { preserve?: boolean }): Promise<void>;
  collectDiagnostics(directory: string): Promise<void>;
}

export interface FirecrackerRuntimeBackendDependencies {
  startInfrastructure: WorkflowDependencies['startContainers'];
  preflight(config: FirecrackerOptions): Promise<FirecrackerPreflightResult>;
  resolveInfrastructure(enableApiProxy: boolean, ipPath?: string): Promise<MicrovmInfrastructureSnapshot>;
  createManager(
    config: FirecrackerOptions,
    workDir: string,
    infrastructure: MicrovmInfrastructureSnapshot,
    workspacePath: string,
    homePath: string,
    identity: { uid: number; gid: number },
  ): FirecrackerManagerAdapter;
  workspacePath(): string;
  homePath(): string;
  identity(): { uid: number; gid: number };
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
  logger: FirecrackerBackendLogger;
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): FirecrackerRuntimeBackendDependencies {
  return {
    startInfrastructure,
    preflight: runFirecrackerPreflight,
    resolveInfrastructure: (enableApiProxy, ipPath) =>
      resolveMicrovmInfrastructure(enableApiProxy, undefined, ipPath),
    createManager: (config, workDir, infrastructure, workspacePath, homePath, identity) =>
      new FirecrackerManager(
        config,
        workDir,
        undefined,
        undefined,
        {
          infrastructureBridge: infrastructure.bridgeName,
          enableApiProxy: Boolean(infrastructure.apiProxyIp),
        },
        {
          workspacePath,
          homePath,
          supervisorBinaryPath: config.supervisorPath!,
          supervisorSha256: config.sha256!.supervisor!,
          identity,
        },
      ),
    workspacePath: () => process.env.GITHUB_WORKSPACE || process.cwd(),
    homePath: getRealUserHome,
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
export const firecrackerRuntimeTestHelpers = { defaultDependencies };

/** Stateful adapter for an explicitly enabled, fail-closed Firecracker microVM. */
export class FirecrackerRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = 'firecracker';

  private manager: FirecrackerManagerAdapter | undefined;
  private environment: Record<string, string> | undefined;
  private activeExecution:
    | { requestId: string; promise: Promise<GuestExecutionResult> }
    | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private identity: { uid: number; gid: number } | undefined;
  private preflightResult: FirecrackerPreflightResult | undefined;

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: FirecrackerRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    const firecracker = requireFirecrackerConfig(this.config);
    if (
      this.config.agentTimeout !== undefined &&
      this.config.agentTimeout * 60_000 > FIRECRACKER_MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `Firecracker preview supports --agent-timeout values up to ${
          FIRECRACKER_MAX_TIMEOUT_MS / 60_000
        } minutes`,
      );
    }
    assertFirecrackerRuntimeCompatibility(this.config, firecracker);
    this.preflightResult = await this.dependencies.preflight(firecracker);
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
      '[firecracker] runtime=firecracker maturity=preview fallback=disabled',
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
      const firecracker = requireFirecrackerConfig(this.config);
      const infrastructure = await this.dependencies.resolveInfrastructure(
        Boolean(this.config.enableApiProxy),
        this.preflightResult?.tools.ip,
      );
      this.identity = this.dependencies.identity();
      this.manager = this.dependencies.createManager(
        firecracker,
        workDir,
        infrastructure,
        this.dependencies.workspacePath(),
        this.dependencies.homePath(),
        this.identity,
      );

      stage = 'topology-revalidation';
      await infrastructure.revalidate();
      stage = 'jailer-configuration';
      await this.manager.start();
      if (!this.manager.guestIp) {
        throw new Error('Firecracker manager did not expose the configured guest IP');
      }
      this.environment = buildFirecrackerGuestEnvironment(
        this.config,
        infrastructure,
        this.manager.guestIp,
      );
      stage = 'guest-boot';
      await this.manager.startInstance();
      stage = 'guest-connectivity';
      await this.probeGuestConnectivity();
      this.dependencies.logger.info('[firecracker] stage=ready');
    } catch (error) {
      this.dependencies.logger.warn(
        `[firecracker] stage=${stage} status=failed: ${formatError(error)}`,
      );
      try {
        await this.manager?.stop();
      } catch (cleanupError) {
        const combined = new Error(
          `Firecracker startup failed: ${formatError(error)}; ` +
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
      throw new Error('Firecracker microVM is not ready');
    }
    if (this.config.tty) {
      throw new Error(
        'Firecracker preview guest supervisor does not support TTY execution',
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
      cwd: FIRECRACKER_GUEST_WORKSPACE,
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
          `Firecracker guest stdin forwarding failed: ${formatError(error)}`,
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
        `[firecracker] Agent command exited with code ${result.exitCode}` +
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
    if (!this.manager) return;
    const directory = this.config.auditDir
      ? `${this.config.auditDir}/firecracker`
      : `${this.config.workDir}/diagnostics/firecracker`;
    await this.manager.collectDiagnostics(directory);
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
          `[firecracker] Preserved jail: ${this.manager.paths.jailRoot}`,
        );
        this.dependencies.logger.info(
          `[firecracker] Preserved images: ${this.config.workDir}/firecracker-images`,
        );
        if (this.manager.networkNamespace) {
          this.dependencies.logger.info(
            `[firecracker] Preserved network namespace: ${this.manager.networkNamespace}`,
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
        new Promise<void>((resolve) => setTimeout(resolve, FIRECRACKER_CANCEL_GRACE_MS)),
      ]);
    }
    await this.manager?.stop({ preserve });
  }

  private async probeGuestConnectivity(): Promise<void> {
    const manager = this.manager!;
    const environment = this.environment!;
    const identity = this.identity;
    if (!identity) {
      throw new Error('Firecracker guest identity is not ready');
    }
    const squidProbe =
      `curl --silent --show-error --max-time 5 --output /dev/null ` +
      `http://${SQUID_IP}:3128/`;
    const apiProxyProbe = this.config.enableApiProxy
      ? ` && curl --fail --silent --show-error --max-time 5 --noproxy '*' ` +
        `--output /dev/null http://${API_PROXY_IP}:10000/reflect`
      : '';
    const result = await manager.execute({
      requestId: `probe-${process.pid}-${Date.now()}`,
      argv: ['/bin/sh', '-c', `set -eu; ${squidProbe}${apiProxyProbe}`],
      env: environment,
      cwd: FIRECRACKER_GUEST_WORKSPACE,
      ...identity,
      timeoutMs: FIRECRACKER_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Firecracker guest connectivity probe failed with exit code ${result.exitCode}`,
      );
    }
    this.dependencies.logger.info(
      '[firecracker] Guest supervisor, Squid, and API proxy connectivity verified',
    );
  }
}

export function buildFirecrackerGuestEnvironment(
  config: WrapperConfig,
  infrastructure: Pick<MicrovmInfrastructureSnapshot, 'squidIp' | 'apiProxyIp'>,
  guestIp = '100.64.0.2',
): Record<string, string> {
  const networkConfig = {
    subnet: NETWORK_SUBNET,
    squidIp: infrastructure.squidIp,
    agentIp: guestIp,
    proxyIp: infrastructure.apiProxyIp,
  };
  const environment = buildAgentEnvironment({
    config,
    networkConfig,
    dnsServers: [],
  });
  if (config.enableApiProxy) {
    Object.assign(environment, buildAgentCredentialEnv({ config, networkConfig }));
  }
  Object.assign(environment, {
    HOME: FIRECRACKER_GUEST_HOME,
    PWD: FIRECRACKER_GUEST_WORKSPACE,
    AWF_WORKDIR: FIRECRACKER_GUEST_WORKSPACE,
    SQUID_PROXY_HOST: infrastructure.squidIp,
    HOSTNAME: 'awf-firecracker',
    AWF_RUNTIME: 'firecracker',
  });
  assertNoProviderSecrets(config, environment);
  return environment;
}

function assertNoProviderSecrets(
  config: WrapperConfig,
  environment: Readonly<Record<string, string>>,
): void {
  const secrets = [
    config.openaiApiKey,
    config.anthropicApiKey,
    config.copilotGithubToken,
    config.copilotProviderApiKey,
    config.geminiApiKey,
    config.googleApiKey,
    config.githubToken,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const [name, value] of Object.entries(environment)) {
    if (secrets.some((secret) => value === secret || value.includes(secret))) {
      throw new Error(
        `Refusing to pass a real provider credential through Firecracker guest variable ${name}`,
      );
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFirecrackerRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): FirecrackerRuntimeBackend {
  return new FirecrackerRuntimeBackend(config, defaultDependencies(startInfrastructure));
}
