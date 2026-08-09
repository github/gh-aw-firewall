import { execSync } from 'child_process';
import type { WorkflowDependencies } from './cli-workflow';
import type { ExternalAgentRuntimeBackend } from './external-runtime-backend';
import { logger } from './logger';
import {
  assertSbxApiProxyReflect,
  createSandbox,
  execInSandbox,
  isSbxAvailable,
  removeSandbox,
  SBX_DEFAULT_NAME,
} from './sbx-manager';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { buildAgentEnvironment } from './services/agent-service';
import { buildAgentCredentialEnv } from './services/api-proxy-credential-env';
import {
  AGENT_IP,
  CLI_PROXY_IP,
  DOH_PROXY_IP,
  NETWORK_SUBNET,
  SQUID_IP,
} from './host-iptables-shared';
import type { WrapperConfig } from './types';

export const SBX_GATEWAY_IP = '172.17.0.0';
export const SBX_HOST_DOCKER_INTERNAL = 'host.docker.internal';

interface SbxBackendLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

interface HostCommandOptions {
  encoding: 'utf-8';
  timeout: number;
}

export interface SbxRuntimeBackendDependencies {
  startInfrastructure: WorkflowDependencies['startContainers'];
  isAvailable: typeof isSbxAvailable;
  createSandbox: typeof createSandbox;
  execInSandbox: typeof execInSandbox;
  assertApiProxyReflect: typeof assertSbxApiProxyReflect;
  removeSandbox: typeof removeSandbox;
  execHostCommand(command: string, options: HostCommandOptions): string;
  getWorkspaceDir(): string;
  logger: SbxBackendLogger;
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): SbxRuntimeBackendDependencies {
  return {
    startInfrastructure,
    isAvailable: isSbxAvailable,
    createSandbox,
    execInSandbox,
    assertApiProxyReflect: assertSbxApiProxyReflect,
    removeSandbox,
    execHostCommand: (command, options) => execSync(command, options),
    getWorkspaceDir: () => process.env.GITHUB_WORKSPACE || process.cwd(),
    logger,
  };
}

/** Stateful adapter for the Docker sbx external microVM runtime. */
export class SbxRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = 'sbx';

  private sandboxName = SBX_DEFAULT_NAME;
  private environment: Record<string, string> | undefined;
  private sandboxCreated = false;
  private stopped = false;

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: SbxRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    if (!await this.dependencies.isAvailable()) {
      throw new Error('Docker sbx CLI not found. Install sbx to use --container-runtime sbx.');
    }
  }

  readonly start: WorkflowDependencies['startContainers'] = async (
    workDir,
    allowedDomains,
    proxyLogsDir,
    skipPull,
    onNetworkReady,
    onInfrastructureReady,
  ) => {
    await this.dependencies.startInfrastructure(
      workDir,
      allowedDomains,
      proxyLogsDir,
      skipPull,
      onNetworkReady,
      onInfrastructureReady,
    );

    await this.preflight();

    this.environment = buildAgentEnvironment({
      config: this.config,
      networkConfig: {
        subnet: NETWORK_SUBNET,
        squidIp: SBX_GATEWAY_IP,
        agentIp: AGENT_IP,
        proxyIp: this.config.enableApiProxy ? SBX_HOST_DOCKER_INTERNAL : undefined,
        dohProxyIp: this.config.dnsOverHttps ? DOH_PROXY_IP : undefined,
        cliProxyIp: this.config.difcProxyHost ? CLI_PROXY_IP : undefined,
      },
      dnsServers: this.config.dnsServers || DEFAULT_DNS_SERVERS,
    });

    if (this.config.enableApiProxy) {
      Object.assign(
        this.environment,
        buildAgentCredentialEnv({
          config: this.config,
          networkConfig: {
            subnet: NETWORK_SUBNET,
            squidIp: SBX_GATEWAY_IP,
            agentIp: AGENT_IP,
            proxyIp: SBX_HOST_DOCKER_INTERNAL,
          },
        }),
      );
    }

    this.logEnvironment();

    this.sandboxName = await this.dependencies.createSandbox({
      workspaceDir: this.dependencies.getWorkspaceDir(),
      squidIp: SQUID_IP,
      extraMounts: [...(this.config.volumeMounts ?? [])],
    });
    this.sandboxCreated = true;

    if (this.config.enableApiProxy) {
      this.dependencies.logger.info('[sbx] Verifying api-proxy /reflect access...');
      await this.dependencies.assertApiProxyReflect(
        this.sandboxName,
        this.environment,
        this.config.containerWorkDir,
      );
    }

    this.dependencies.logger.info('[sbx-diag] Verifying squid proxy connectivity...');
    const diagnosticCommand = [
      `echo -n "squid ${SBX_GATEWAY_IP}:3128 -> "`,
      `curl -sS --max-time 5 --proxy "http://${SBX_GATEWAY_IP}:3128" -o /dev/null -w "%{http_code}" https://api.github.com/ 2>&1`,
      'echo ""',
    ].join(' && ');
    const diagnosticResult = await this.dependencies.execInSandbox(
      this.sandboxName,
      diagnosticCommand,
      {
        timeoutMinutes: 1,
        workDir: this.config.containerWorkDir,
        environment: this.environment,
      },
    );
    this.dependencies.logger.info(
      `[sbx-diag] Connectivity check exited with code ${diagnosticResult.exitCode}`,
    );
  };

  readonly exec: WorkflowDependencies['runAgentCommand'] = async (
    _workDir,
    _allowedDomains,
    _proxyLogsDir,
    agentTimeoutMinutes,
  ) => {
    if (!this.sandboxCreated) {
      throw new Error('Sandbox not created');
    }

    this.dependencies.logger.info(
      `[sbx] Launching agent command in sandbox "${this.sandboxName}" (timeout: ${agentTimeoutMinutes ?? 'none'} min)`,
    );
    this.dependencies.logger.debug(
      `[sbx] Agent command: ${this.config.agentCommand.substring(0, 200)}...`,
    );
    const result = await this.dependencies.execInSandbox(
      this.sandboxName,
      this.config.agentCommand,
      {
        timeoutMinutes: agentTimeoutMinutes,
        workDir: this.config.containerWorkDir,
        environment: this.environment,
        tty: this.config.tty,
      },
    );
    this.dependencies.logger.info(`[sbx] Agent command exited with code ${result.exitCode}`);

    if (this.config.enableApiProxy && result.exitCode !== 0) {
      await this.collectDiagnostics();
    }

    return { exitCode: result.exitCode };
  };

  async collectDiagnostics(): Promise<void> {
    if (!this.config.enableApiProxy) return;

    try {
      const proxyLogs = this.dependencies.execHostCommand(
        'docker logs --tail 80 awf-api-proxy 2>&1',
        { encoding: 'utf-8', timeout: 10_000 },
      );
      this.dependencies.logger.info(`[sbx-diag] api-proxy logs:\n${proxyLogs}`);
      const healthStatus = this.dependencies.execHostCommand(
        'docker inspect --format={{.State.Health.Status}} awf-api-proxy 2>&1',
        { encoding: 'utf-8', timeout: 5_000 },
      );
      this.dependencies.logger.info(
        `[sbx-diag] api-proxy health status: ${healthStatus.trim()}`,
      );
    } catch {
      // Diagnostics are best effort and must not alter the agent exit code.
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.dependencies.removeSandbox(this.sandboxName);
    } catch {
      // The sandbox may not exist yet when startup or signal handling fails.
    }
  }

  private logEnvironment(): void {
    const environment = this.environment!;
    this.dependencies.logger.info(
      `[sbx-env] COPILOT_API_URL=${environment.COPILOT_API_URL || '(unset)'}`,
    );
    this.dependencies.logger.info(
      `[sbx-env] COPILOT_PROVIDER_BASE_URL=${environment.COPILOT_PROVIDER_BASE_URL || '(unset)'}`,
    );
    this.dependencies.logger.info(
      `[sbx-env] COPILOT_GITHUB_TOKEN=${redactSecret(environment.COPILOT_GITHUB_TOKEN)}`,
    );
    this.dependencies.logger.info(
      `[sbx-env] COPILOT_API_KEY=${redactSecret(environment.COPILOT_API_KEY)}`,
    );
    this.dependencies.logger.info(
      `[sbx-env] HTTPS_PROXY=${environment.HTTPS_PROXY || '(unset)'}`,
    );
    this.dependencies.logger.info(
      `[sbx-env] COPILOT_PROVIDER_API_KEY=${redactSecret(environment.COPILOT_PROVIDER_API_KEY)}`,
    );
  }
}

/** Report whether a secret is set (and its length) without exposing the value. */
function redactSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  return `(set, len=${value.length})`;
}

export function createSbxRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): SbxRuntimeBackend {
  return new SbxRuntimeBackend(config, defaultDependencies(startInfrastructure));
}
