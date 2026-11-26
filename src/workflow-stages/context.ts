import type { WrapperConfig, ModelRoutingBootstrapState } from '../types';
import type { HostAccessConfig, CliProxyHostConfig } from '../host-iptables';
import type { ProtectedCommandOutputCapture } from '../protected-command-output-capture';
import type { HarnessProbe } from '../model-information-contract/harness-observation';
import type { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import type { NetworkAddressing } from '../network-subnet';

/**
 * Dependencies injected into the main workflow.
 *
 * These are implemented by `docker-manager.ts` for Docker Compose agents.
 * External agent backends adapt their lifecycle to `startContainers` and
 * `runAgentCommand` while continuing to use compose for infrastructure.
 */
export interface WorkflowDependencies {
  probeHarness?: HarnessProbe;
  /** Release Docker's pre-command gate only after publication and eligibility recheck. */
  releaseHarness?: () => Promise<void>;
  ensureFirewallNetwork: (subnetOverride?: string) => Promise<{ squidIp: string; agentIp: string; proxyIp: string; subnet: string }>;
  setupHostIptables: (squidIp: string, port: number, dnsServers: string[], apiProxyIp?: string, dohProxyIp?: string, hostAccess?: HostAccessConfig, cliProxyConfig?: CliProxyHostConfig, gatewayIp?: string) => Promise<void>;
  writeConfigs: (config: WrapperConfig) => Promise<void>;
  startContainers: (
    workDir: string,
    allowedDomains: string[],
    proxyLogsDir?: string,
    skipPull?: boolean,
    onNetworkReady?: () => Promise<void>,
    onInfrastructureReady?: () => Promise<void>,
  ) => Promise<void>;
  runAgentCommand: (
    workDir: string,
    allowedDomains: string[],
    proxyLogsDir?: string,
    agentTimeoutMinutes?: number,
    commandOutputCapture?: ProtectedCommandOutputCapture,
  ) => Promise<{ exitCode: number }>;
  collectDiagnosticLogs?: (workDir: string) => Promise<void>;
  /** Trusted unified enclave preflight and staging. */
  prepareEnclaves?: (config: WrapperConfig) => Promise<void>;
  /**
   * Fail-stop preflight for network-isolation mode. Aborts (process exit) when
   * topology enforcement cannot be supported on the current platform.
   */
  assertTopologySupported?: () => Promise<void>;
  /**
   * Connects externally-launched trusted containers to the internal topology
   * network after the AWF containers have started.
   */
  connectTopologyContainers?: (networkName: string, containerNames: string[]) => Promise<void>;
  /** Attaches and verifies the externally owned gateway on the private enclave control path. */
  connectEnclaveGateway?: (config: WrapperConfig) => Promise<void>;
  /** Proves initialize and the exact enabled tool contracts through mcpg. */
  assertEnclaveGatewayReady?: (config: WrapperConfig) => Promise<void>;
  /** Attaches compiler-owned mcpg to the PAT-free enclave GitHub control path. */
  connectEnclaveGithubGateway?: (config: WrapperConfig) => Promise<void>;
  /** Proves the fixed TLS route through the PAT-free enclave CLI proxy. */
  assertEnclaveGithubGatewayReady?: (config: WrapperConfig) => Promise<void>;
  /**
   * Starts the AWF-private dynamic repository admission authority: mcpg
   * recovery, reconciliation, and the broker admission channel.
   */
  startEnclaveDynamicDelegation?: (config: WrapperConfig) => Promise<void>;
  /** Stages the private routing conversation before any container exists. */
  prepareRouting?: (config: WrapperConfig) => Promise<ModelRoutingBootstrapState | undefined>;
  /** Waits for the proxy-owned routing selection before the primary agent starts. */
  waitForRoutingSelection?: (state: ModelRoutingBootstrapState | undefined) => Promise<void>;
  /** Verifies the proxy's end-of-run routing records after sidecar shutdown. */
  verifyRoutingCompletion?: (state: ModelRoutingBootstrapState | undefined) => Promise<void>;
  /** Removes private routing state after verification unless containers are kept. */
  cleanupRouting?: (config: WrapperConfig) => Promise<void>;
}

interface WorkflowCallbacks {
  onHostIptablesSetup?: () => void;
  onContainersStarted?: () => void;
}

interface WorkflowLogger {
  info: (message: string, ...args: unknown[]) => void;
  success: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface WorkflowOptions extends WorkflowCallbacks {
  logger: WorkflowLogger;
  performCleanup: () => Promise<void>;
  commandOutputCapture?: ProtectedCommandOutputCapture;
}

export interface WorkflowContext {
  config: WrapperConfig;
  dependencies: WorkflowDependencies;
  options: WorkflowOptions;
  checks: HostPreflightReporter;
  addressing: NetworkAddressing;
  routingState?: ModelRoutingBootstrapState;
}
