import type { Writable } from 'stream';
import {
  API_PROXY_IP,
  SQUID_IP,
} from '../config/network-policy';
import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import type { GuestExecutionRequest, GuestExecutionResult } from '../microvm/vsock-client';
import type { WrapperConfig } from '../types';
import { CloudHypervisorRetryableReadinessError } from './preflight';
import {
  CLOUD_HYPERVISOR_API_PROXY_PROBE_TIMEOUT_SECONDS,
  CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_ATTEMPTS,
  CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS,
  connectivityProbeTimeoutMs,
  createBoundedOutputCollector,
  formatError,
  shellSingleQuote,
} from './backend-utils';

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
export const CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS = 90_000;
const CLOUD_HYPERVISOR_GUEST_NETWORK_READY_TIMEOUT_MS = CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS;
const CLOUD_HYPERVISOR_CONNECTIVITY_PROBE_INITIAL_DELAY_SECONDS = 2;
export const MCP_GATEWAY_PORT = 8080;

interface RuntimeReadinessManager {
  readonly guestIp?: string;
  readonly guestGatewayIp?: string;
  readonly guestPrefixLength?: number;
  readonly guestInterfaceName?: string;
  execute(request: GuestExecutionRequest): Promise<GuestExecutionResult>;
}

interface RuntimeReadinessLogger {
  info(message: string, ...args: unknown[]): void;
}

interface ConnectivityProbe {
  readonly name: string;
  readonly command: string;
}

export interface ProbeGuestConnectivityOptions {
  manager: RuntimeReadinessManager;
  environment: Record<string, string>;
  identity: { uid: number; gid: number } | undefined;
  config: Pick<WrapperConfig, 'enableApiProxy'>;
  infrastructure: Pick<MicrovmInfrastructureSnapshot, 'topologyPeerIps'> | undefined;
  logger: RuntimeReadinessLogger;
  bootAttempt: number;
  captureGuestNetworkStateForDiagnostics(): Promise<string>;
}

export async function probeGuestConnectivity({
  manager,
  environment,
  identity,
  config,
  infrastructure,
  logger,
  bootAttempt,
  captureGuestNetworkStateForDiagnostics,
}: ProbeGuestConnectivityOptions): Promise<void> {
  if (!identity) {
    throw new Error('Cloud Hypervisor guest identity is not ready');
  }
  const { probes, topologyPeerCount } = buildConnectivityProbes(config, infrastructure);
  const stdoutCollector = createBoundedOutputCollector();
  const stderrCollector = createBoundedOutputCollector();
  const result = await executeConnectivityProbe({
    manager,
    environment,
    identity,
    probes,
    topologyPeerCount,
    enableApiProxy: Boolean(config.enableApiProxy),
    stdout: stdoutCollector.stream,
    stderr: stderrCollector.stream,
    bootAttempt,
  });
  if (result.exitCode !== 0) {
    await throwConnectivityProbeFailure({
      result,
      stdout: stdoutCollector.toString().trim(),
      stderr: stderrCollector.toString().trim(),
      bootAttempt,
      captureGuestNetworkStateForDiagnostics,
    });
  }
  logger.info(
    '[cloud-hypervisor] Guest supervisor and trusted service connectivity verified',
  );
}

function buildConnectivityProbes(
  config: Pick<WrapperConfig, 'enableApiProxy'>,
  infrastructure: Pick<MicrovmInfrastructureSnapshot, 'topologyPeerIps'> | undefined,
): { probes: ConnectivityProbe[]; topologyPeerCount: number } {
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
  const probes: ConnectivityProbe[] = [
    {
      name: 'squid',
      command: `nc -v -z -w ${CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS} ` +
        `${SQUID_IP} 3128`,
    },
  ];
  if (config.enableApiProxy) {
    probes.push({
      name: 'api-proxy',
      command:
        `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; ` +
        `wget -q -T ${CLOUD_HYPERVISOR_API_PROXY_PROBE_TIMEOUT_SECONDS} ` +
        `-O /dev/null http://${API_PROXY_IP}:10000/reflect`,
    });
  }
  for (const [name, ip] of Object.entries(infrastructure?.topologyPeerIps ?? {})) {
    probes.push({
      name: `topology-peer-${name}`,
      command: `nc -v -z -w ${CLOUD_HYPERVISOR_TCP_PROBE_TIMEOUT_SECONDS} ` +
        `${ip} ${MCP_GATEWAY_PORT}`,
    });
  }
  const topologyPeerCount = Object.keys(infrastructure?.topologyPeerIps ?? {}).length;
  return { probes, topologyPeerCount };
}

function buildConnectivityProbeScript(probes: readonly ConnectivityProbe[]): string {
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
  return `set -u\n${probeFunction}\n${probeCommands}`;
}

interface ExecuteConnectivityProbeOptions {
  manager: RuntimeReadinessManager;
  environment: Record<string, string>;
  identity: { uid: number; gid: number };
  probes: readonly ConnectivityProbe[];
  topologyPeerCount: number;
  enableApiProxy: boolean;
  stdout: Writable;
  stderr: Writable;
  bootAttempt: number;
}

async function executeConnectivityProbe({
  manager,
  environment,
  identity,
  probes,
  topologyPeerCount,
  enableApiProxy,
  stdout,
  stderr,
  bootAttempt,
}: ExecuteConnectivityProbeOptions): Promise<GuestExecutionResult> {
  // Capture (bounded) stdout/stderr so a probe failure can report which
  // leg failed and why, rather than only a bare exit code -- useful for
  // diagnosing this compound nc-then-wget command without a full guest
  // command execution's live output stream.
  try {
    return await manager.execute({
      requestId: `probe-${process.pid}-${Date.now()}`,
      argv: ['/bin/sh', '-c', buildConnectivityProbeScript(probes)],
      env: environment,
      cwd: CLOUD_HYPERVISOR_GUEST_WORKSPACE,
      ...identity,
      timeoutMs: connectivityProbeTimeoutMs(
        topologyPeerCount,
        enableApiProxy,
      ),
      stdout,
      stderr,
    });
  } catch (error) {
    throw new CloudHypervisorRetryableReadinessError(
      'guest-connectivity',
      bootAttempt,
      `connectivity probe could not execute: ${formatError(error)}`,
      error,
    );
  }
}

interface ConnectivityProbeFailureOptions {
  result: GuestExecutionResult;
  stdout: string;
  stderr: string;
  bootAttempt: number;
  captureGuestNetworkStateForDiagnostics(): Promise<string>;
}

async function throwConnectivityProbeFailure({
  result,
  stdout,
  stderr,
  bootAttempt,
  captureGuestNetworkStateForDiagnostics,
}: ConnectivityProbeFailureOptions): Promise<never> {
  const netState = await captureGuestNetworkStateForDiagnostics();
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

export interface WaitForGuestNetworkReadyOptions {
  manager: RuntimeReadinessManager;
  environment: Record<string, string>;
  identity: { uid: number; gid: number } | undefined;
  bootAttempt: number;
}

/**
 * Verify the guest supervisor's network-readiness contract before running
 * the more expensive service-connectivity probe. Current supervisors bring
 * loopback up before opening the vsock listener; this bounded check also
 * fails clearly if a mismatched guest image violates that contract.
 */
export async function waitForGuestNetworkReady({
  manager,
  environment,
  identity,
  bootAttempt,
}: WaitForGuestNetworkReadyOptions): Promise<void> {
  if (!identity) {
    throw new Error('guest-network-not-ready: Cloud Hypervisor guest identity is not ready');
  }
  const plan = requireGuestNetworkPlan(manager);
  const script = buildGuestNetworkReadinessScript(plan);
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
        `${plan.guestInterfaceName} state UP with ${plan.expectedAddress}, and default route via ` +
        `${plan.guestGatewayIp} (${formatError(error)})`,
      error,
    );
  }
}

interface GuestNetworkPlan {
  readonly guestGatewayIp: string;
  readonly guestInterfaceName: string;
  readonly expectedAddress: string;
}

function requireGuestNetworkPlan(manager: RuntimeReadinessManager): GuestNetworkPlan {
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
  return {
    guestGatewayIp,
    guestInterfaceName,
    expectedAddress: `${guestIp}/${guestPrefixLength}`,
  };
}

function buildGuestNetworkReadinessScript({
  guestGatewayIp,
  guestInterfaceName,
  expectedAddress,
}: GuestNetworkPlan): string {
  return [
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
}
