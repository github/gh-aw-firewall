import { buildInternalServiceHosts } from '../services/internal-service-hosts';
import { TOPOLOGY_NETWORK_NAME, getTopologyContainerIps, patchComposeWithTopologyHosts } from '../topology';
import { assertEnclaveStartupChecklistComplete, updateEnclaveStartupProgress } from '../enclave/startup-progress';
import { attachEnclaveGateways } from './enclave-attach';
import type { WorkflowContext } from './context';

export async function startWorkflowContainers(context: WorkflowContext): Promise<void> {
  const { config, dependencies, checks, addressing, options: { logger, onContainersStarted } } = context;
  // Step 2: Start containers.
  //
  // In network-isolation (topology) mode with topology-attach peers, use a phased
  // startup to break the ordering deadlock: the cli-proxy liveness probe requires
  // the external DIFC peer to be reachable on awf-net, but the peer is only joined
  // to awf-net after startContainers() returns — a circular dependency that causes
  // EAI_AGAIN → fail-fast → agent never invoked.
  //
  // Fix: pass an onNetworkReady hook so startContainers() can:
  //   1. Start squid-proxy alone (creates awf-net, no health-gated dependents).
  //   2. Invoke onNetworkReady() — attaches the topology peers to awf-net.
  //   3. Run the full docker compose up — cli-proxy probe resolves the peer.
  //
  // Non-topology runs (no onNetworkReady) keep the existing single-up path.
  const onNetworkReady =
    config.networkIsolation &&
    config.topologyAttach &&
    config.topologyAttach.length > 0 &&
    dependencies.connectTopologyContainers
      ? async () => {
          logger.info(`Attaching ${config.topologyAttach!.length} trusted container(s) to the internal network...`);
          await dependencies.connectTopologyContainers!(TOPOLOGY_NETWORK_NAME, config.topologyAttach!);

          // Docker's embedded DNS (127.0.0.11) is not always reachable from
          // inside the sandbox: gVisor's userspace netstack cannot reach it,
          // and on ARC/DinD runners the Docker-in-Docker network does not
          // forward lookups to the Kubernetes cluster resolver — which is what
          // produces "getaddrinfo EAI_AGAIN <peer>" failures.
          //
          // Every peer we might resolve here is known in advance with a fixed
          // IP: the topology peers (e.g. the MCP gateway) are discovered via
          // `getTopologyContainerIps`, and the compose-internal proxies have
          // static IPs. So we always pre-register them in /etc/hosts whenever
          // network isolation is active. This is a no-op when embedded DNS
          // works (the entries match what DNS would return) and prevents the
          // DNS-isolation failure when it does not — turning a diagnosis into a
          // fix. Previously this ran only for gVisor; ARC/DinD needs it too.
          {
            const peerIps = await getTopologyContainerIps(TOPOLOGY_NETWORK_NAME, config.topologyAttach!);

            // Include compose-internal services whose hostnames the agent may
            // need to resolve — normally handled by Docker DNS at 127.0.0.11.
            // Uses the same service→name mapping as the gVisor compose path
            // (buildInternalServiceHosts); the topology path sources the fixed
            // sidecar IPs from constants since it has no host networkConfig.
            for (const [name, ip] of Object.entries(buildInternalServiceHosts({
              squidIp: addressing.squidIp,
              apiProxyIp: config.enableApiProxy ? addressing.proxyIp : undefined,
              cliProxyIp: config.difcProxyHost ? addressing.cliProxyIp : undefined,
            }))) {
              peerIps.set(name, ip);
            }

            if (peerIps.size > 0) {
              patchComposeWithTopologyHosts(config.workDir, peerIps);
            }
          }
        }
      : undefined;

  let infrastructureCheckPassed = false;
  const enclaveInfrastructureReady = config.enclaves?.enabled
    ? async () => {
      // The Docker lifecycle invokes this after infrastructure service startup.
      await checks.check('infrastructure', () => undefined);
      infrastructureCheckPassed = true;
      await attachEnclaveGateways(context);
    }
    : undefined;
  const routingInfrastructureReady = config.experimentalModelRouting === true && config.modelRouting
    ? async () => {
      if (!dependencies.waitForRoutingSelection) {
        throw new Error('Model routing is enabled but no selection wait implementation was provided');
      }
      logger.info('Waiting for model routing selection...');
      await dependencies.waitForRoutingSelection(context.routingState);
    }
    : undefined;
  const onInfrastructureReady = enclaveInfrastructureReady || routingInfrastructureReady
    ? async () => {
      if (enclaveInfrastructureReady) await enclaveInfrastructureReady();
      if (routingInfrastructureReady) await routingInfrastructureReady();
    }
    : undefined;

  try {
    updateEnclaveStartupProgress(config, { stage: 'containers' });
    checks.attempt('infrastructure');
    await dependencies.startContainers(
      config.workDir,
      config.allowedDomains,
      config.proxyLogsDir,
      config.skipPull,
      onNetworkReady,
      onInfrastructureReady,
    );
  } catch (startError) {
    if (config.enclaves?.enabled && !infrastructureCheckPassed) {
      checks.fail('infrastructure', startError);
    }
    // Signal that containers may have been partially created so the caller's
    // cleanup (stopContainers / docker compose down -v) will tear them down
    // instead of leaving orphaned containers and networks.
    onContainersStarted?.();

    // Collect diagnostics for startup failures before containers are torn down.
    // Must happen before performCleanup() / stopContainers() destroys them.
    if (config.diagnosticLogs && dependencies.collectDiagnosticLogs) {
      try {
        await dependencies.collectDiagnosticLogs(config.workDir);
      } catch (diagError) {
        logger.warn('Failed to collect diagnostic logs; continuing with cleanup.', diagError);
      }
    }
    throw startError;
  }
  onContainersStarted?.();
  assertEnclaveStartupChecklistComplete(config);
}
