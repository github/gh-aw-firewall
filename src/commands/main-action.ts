import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../logger';
import { assertPersistentDebugArtifactsIsolated } from '../enclave/mount-policy';
import {
  writeConfigs,
  startContainers,
  runAgentCommand,
  stopContainers,
  cleanup,
  preserveIptablesAudit,
  fastKillAgentContainer,
  collectDiagnosticLogs,
  setAwfDockerHost,
} from '../docker-manager';
import {
  ensureFirewallNetwork,
  setupHostIptables,
  cleanupHostIptables,
} from '../host-iptables';
import { runMainWorkflow } from '../cli-workflow';
import { deriveSensitiveEndpointForms, redactSecrets, redactSensitiveValues } from '../redact-secrets';
import { joinShellArgs } from '../option-parsers';
import { assertRealDirectory, writeFileNoFollow } from '../fs-utils';
import {
  exportResolvedConfigPath,
  publishEarlyResolvedConfig,
  publishFinalResolvedConfig,
} from '../resolved-config-artifact';
import { applyConfigFilePrecedence } from './preflight';
import { registerSignalHandlers } from './signal-handler';
import { validateOptions } from './validate-options';
import { probeSplitFilesystem } from '../dind-probe';
import { assertTopologySupported, connectTopologyContainers } from '../topology';
import { runDindBootstrap } from '../dind-bootstrap';
import { adaptExternalRuntimeBackend } from '../external-runtime-backend';
import type { ExternalAgentRuntimeBackend } from '../external-runtime-backend';
import { resolveExternalRuntimeBackend } from '../external-runtime-backend-resolver';
import { prepareEnclaves, teardownEnclaves } from '../enclave/manager';
import {
  closeCloudHypervisorEnclaveAdmissions,
  stopCloudHypervisorEnclaveLifecycle,
} from '../enclave/cloud-hypervisor-lifecycle';
import {
  closeDockerEnclaveAdmissions,
  isDockerEnclaveSelected,
  stopDockerEnclaveLifecycle,
} from '../enclave/docker-lifecycle';
import {
  startEnclaveDynamicDelegation,
  stopEnclaveDynamicDelegation,
} from '../enclave/dynamic-delegation';
import { getStartupDiagnosticPath } from '../logs/startup-diagnostics';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import {
  getEnclaveStartupProgress,
  initializeEnclaveStartupProgress,
  updateEnclaveStartupProgress,
} from '../enclave/startup-progress';
import {
  assertEnclaveGatewayReady,
  connectEnclaveGateway,
  shutdownEnclaveGateway,
} from '../enclave/gateway';
import { captureEnclaveStartupDiagnostics } from '../enclave/startup-diagnostics';
import {
  assertEnclaveGithubGatewayReady,
  connectEnclaveGithubGateway,
  disconnectEnclaveGithubGateway,
} from '../enclave/github-gateway';
import type { WrapperConfig } from '../types';
import {
  prepareProtectedCommandOutputCapture,
  type ProtectedCommandOutputCapture,
} from '../protected-command-output-capture';
import {
  formatCloudHypervisorDockerFallbackWarning,
  isCloudHypervisorUnsupportedHostError,
} from '../cloud-hypervisor/errors';
import {
  cleanupRoutingState,
  RoutingFailureExitError,
  stageRoutingConversation,
  verifyRoutingCompletion,
  waitForRoutingSelection,
} from '../routing/bootstrap';

const SENSITIVE_CONFIG_KEYS = new Set([
  'openaiApiKey',
  'anthropicApiKey',
  'copilotGithubToken',
  'copilotProviderApiKey',
  'geminiApiKey',
  'googleApiKey',
  'githubToken',
  // Secret-derived allowlist entries must not appear in logs or the audit artifact.
  'sensitiveAllowedDomains',
]);

const REFLECT_COMMAND = 'curl --fail --silent --show-error --noproxy "*" http://api-proxy:10000/reflect';
const resolvedConfigSnapshots = new WeakMap<WrapperConfig, string>();

function findRoutingFailure(error: unknown): RoutingFailureExitError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof RoutingFailureExitError) return current;
    seen.add(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
}

function redactConfigForLogging(config: WrapperConfig): Record<string, unknown> {
  const redactedConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.has(key)) continue;

    if (key === 'agentCommand') {
      redactedConfig[key] = redactSecrets(value as string);
      continue;
    }

    if (key === 'additionalEnv' && value && typeof value === 'object') {
      redactedConfig[key] = Object.fromEntries(
        Object.keys(value as Record<string, string>).map((envKey) => [envKey, '[REDACTED]']),
      );
      continue;
    }

    redactedConfig[key] = value;
  }
  return redactedConfig;
}

function persistConfigAuditArtifact(
  config: WrapperConfig,
  redactedConfig: Record<string, unknown>,
): void {
  try {
    const contents = JSON.stringify(redactedConfig, null, 2) + '\n';
    resolvedConfigSnapshots.set(config, contents);
    if (process.platform === 'linux' && process.geteuid?.() === 0) {
      const file = publishEarlyResolvedConfig(contents);
      exportResolvedConfigPath(file);
    }
  } catch (err) {
    logger.warn('Failed to publish resolved config artifact:', err);
  }
}

// Large enough for the full cumulative checklist plus late-stage gateway
// evidence; the CI reader uses the same bound.
const STARTUP_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

type StartupDiagnosticWriteOutcome =
  | 'written' | 'oversize' | 'unsafe-target' | 'io-error' | 'error' | 'not-attempted';
type StartupDiagnosticWriteReason =
  | 'record-too-large' | 'unsafe-directory' | 'unsafe-symlink' | 'unsafe-type'
  | 'unsafe-link-count' | 'unsafe-owner' | 'permission-denied' | 'io-error' | 'unknown';

function writeStartupFailureDiagnostic(
  config: WrapperConfig,
  error: unknown,
  phase = 'startup',
  onRejected?: (reason: StartupDiagnosticWriteReason) => void,
): StartupDiagnosticWriteOutcome {
  const rejected = (
    outcome: StartupDiagnosticWriteOutcome,
    reason: StartupDiagnosticWriteReason,
  ): StartupDiagnosticWriteOutcome => {
    onRejected?.(reason);
    return outcome;
  };
  try {
    const proxyLogsDir = config.proxyLogsDir || path.join(config.workDir, 'squid-logs');
    fs.mkdirSync(proxyLogsDir, { recursive: true, mode: 0o755 });
    try {
      assertRealDirectory(proxyLogsDir);
    } catch {
      return rejected('unsafe-target', 'unsafe-directory');
    }
    let enclaveStartup = getEnclaveStartupProgress(config);
    const redactedMessage = redactSensitiveValues(
      redactSecrets(error instanceof Error ? error.message : String(error)),
      deriveSensitiveEndpointForms(config.sensitiveAllowedDomains),
    );
    const messageBound = enclaveStartup?.hostPreflight ? 1024 : 8 * 1024;
    let message = enclaveStartup && Buffer.byteLength(JSON.stringify(redactedMessage), 'utf8') > messageBound
      ? 'Enclave startup failure exceeded diagnostic message bound'
      : redactedMessage;
    const timestamp = new Date().toISOString();
    const serialize = (): string => JSON.stringify({
      timestamp, phase, message,
      ...(enclaveStartup ? { enclaveStartup } : {}),
    }, null, enclaveStartup?.startupChecks ? undefined : 2) + '\n';
    let record = serialize();
    if (enclaveStartup?.startupChecks && Buffer.byteLength(record, 'utf8') > STARTUP_DIAGNOSTIC_MAX_BYTES) {
      // The cumulative checklist already retains every active-scope check.
      enclaveStartup = { ...enclaveStartup, hostPreflight: undefined };
      record = serialize();
    }
    if (enclaveStartup?.startupChecks && Buffer.byteLength(record, 'utf8') > STARTUP_DIAGNOSTIC_MAX_BYTES) {
      message = 'Enclave startup failure exceeded diagnostic message bound';
      record = serialize();
    }
    if (enclaveStartup && Buffer.byteLength(record, 'utf8') > STARTUP_DIAGNOSTIC_MAX_BYTES) {
      return rejected('oversize', 'record-too-large');
    }
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_NONBLOCK |
      (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(getStartupDiagnosticPath(proxyLogsDir), flags, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return rejected('unsafe-target', 'unsafe-type');
      if (stat.nlink !== 1) return rejected('unsafe-target', 'unsafe-link-count');
      if (stat.uid !== process.getuid?.()) return rejected('unsafe-target', 'unsafe-owner');
      fs.fchmodSync(fd, 0o600);
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, record);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o644);
    } finally {
      fs.closeSync(fd);
    }
    return 'written';
  } catch (diagnosticError) {
    const code = (diagnosticError as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP') return rejected('unsafe-target', 'unsafe-symlink');
    if (code === 'EACCES' || code === 'EPERM') return rejected('io-error', 'permission-denied');
    if (typeof code === 'string') return rejected('io-error', 'io-error');
    return rejected('error', 'unknown');
  }
}

interface StartupExitState {
  startedAt: number;
  lastProgressWrite: StartupDiagnosticWriteOutcome;
  progressWriteFailures: number;
  firstProgressWriteFailure?: StartupDiagnosticWriteReason;
  lastProgressWriteFailure?: StartupDiagnosticWriteReason;
}

function startupElapsedBucket(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const buckets: Array<[number, string]> = [
    [60_000, '<1m'], [3 * 60_000, '<3m'], [5 * 60_000, '<5m'], [8 * 60_000, '<8m'],
    [10 * 60_000, '<10m'], [15 * 60_000, '<15m'],
  ];
  return buckets.find(([limit]) => ms < limit)?.[1] ?? '>=15m';
}

/**
 * Emits one fixed-code enclave startup exit marker on stderr. It carries no
 * messages, paths or identifiers, so CI can read it even when the structured
 * record is missing and AWF runs with `--log-level error`.
 */
function emitStartupExitMarker(
  config: WrapperConfig,
  state: StartupExitState,
  marker: {
    path: 'fatal' | 'workflow-return';
    exitCode: number;
    containersStarted: boolean;
    agentStarted: boolean;
    recordWrite: StartupDiagnosticWriteOutcome;
    recordWriteReason?: StartupDiagnosticWriteReason | null;
    cleanup: 'pending' | 'completed' | 'failed';
  },
): void {
  if (!config.enclaves?.enabled) return;
  try {
    const progress = getEnclaveStartupProgress(config);
    const failedCheck = Object.entries(progress?.startupChecks?.checks ?? {})
      .find(([, [result]]) => result === 'failed')?.[0] ?? null;
    let recordAfterCleanup: 'present' | 'missing' | 'unknown' = 'unknown';
    if (marker.cleanup !== 'pending') {
      const proxyLogsDir = config.proxyLogsDir || path.join(config.workDir, 'squid-logs');
      recordAfterCleanup = fs.existsSync(getStartupDiagnosticPath(proxyLogsDir)) ? 'present' : 'missing';
    }
    process.stderr.write(`AWF_STARTUP_EXIT ${JSON.stringify({
      schemaVersion: 1,
      path: marker.path,
      exitCode: Number.isInteger(marker.exitCode) && marker.exitCode >= 0 && marker.exitCode <= 255
        ? marker.exitCode : 255,
      stage: progress?.stage ?? null,
      failedCheck,
      containersStarted: marker.containersStarted,
      agentStarted: marker.agentStarted,
      recordWrite: marker.recordWrite,
      recordWriteReason: marker.recordWriteReason ?? null,
      lastProgressWrite: state.lastProgressWrite,
      progressWriteFailures: state.progressWriteFailures,
      firstProgressWriteFailure: state.firstProgressWriteFailure ?? null,
      lastProgressWriteFailure: state.lastProgressWriteFailure ?? null,
      cleanup: marker.cleanup,
      recordAfterCleanup,
      elapsed: startupElapsedBucket(Date.now() - state.startedAt),
    })}\n`);
  } catch {
    // Diagnostics must never change the exit path.
  }
}

function writeIncompleteEnclaveAuditMarker(targetAuditDir: string): void {
  fs.mkdirSync(targetAuditDir, { recursive: true, mode: 0o755 });
  assertRealDirectory(targetAuditDir);
  writeFileNoFollow(
    path.join(targetAuditDir, 'enclave-audit-incomplete.txt'),
    'Enclave shutdown or protected audit preservation was not confirmed; enclave audit artifacts may be incomplete.\n',
    0o644,
  );
}

function buildCleanupFn(
  config: WrapperConfig,
  getContainersStarted: () => boolean,
  getHostIptablesSetup: () => boolean,
  externalRuntimeBackend?: ExternalAgentRuntimeBackend,
) {
  // The workflow cleans up before verifying routing completion; the fatal
  // path and signal handlers must not tear down a removed work directory again.
  let cleanupRun: Promise<void> | undefined;
  return (signal?: string): Promise<void> => {
    cleanupRun ??= runCleanup(config, getContainersStarted, getHostIptablesSetup, externalRuntimeBackend, signal);
    return cleanupRun;
  };
}

async function runCleanup(
  config: WrapperConfig,
  getContainersStarted: () => boolean,
  getHostIptablesSetup: () => boolean,
  externalRuntimeBackend: ExternalAgentRuntimeBackend | undefined,
  signal: string | undefined,
): Promise<void> {
  let externalRuntimeCleanupError: unknown;
  const dockerEnclaves = isDockerEnclaveSelected(config);
  if (signal) {
    logger.info(`Received ${signal}, cleaning up...`);
  }
  closeCloudHypervisorEnclaveAdmissions(config);
  closeDockerEnclaveAdmissions(config);

  if (externalRuntimeBackend) {
    try {
      if (config.diagnosticLogs) {
        await externalRuntimeBackend.collectDiagnostics();
      }
      if (config.keepContainers && externalRuntimeBackend.preserve) {
        await externalRuntimeBackend.preserve();
      } else if (!config.keepContainers) {
        await externalRuntimeBackend.stop();
      }
    } catch (error) {
      externalRuntimeCleanupError = error;
      logger.warn(
        config.containerRuntime === 'cloud-hypervisor' && config.enclaves?.enabled
          ? 'Unified Cloud Hypervisor cleanup failed; infrastructure and recovery state must be preserved.'
          : 'External runtime cleanup failed; continuing with infrastructure teardown.',
        error,
      );
    }
  }

  // Let the enclave server emit final cleanup telemetry before preserving
  // container artifacts. Stopped containers remain available to docker cp
  // until the subsequent compose down removes them.
  let containersStarted = false;
  let enclaveAuditComplete = true;
  let auditRecoveryFailure: { error: unknown } | undefined;
  try {
    containersStarted = getContainersStarted();
    // Keep delegated identities and sidecars alive through host cancellation.
    // Failure retains networks, seeds and recovery state, but still saves audit.
    await stopDockerEnclaveLifecycle(config);
    if (containersStarted || dockerEnclaves) {
      try {
        // Revoke every outstanding dynamic identity before the broker and the
        // gateway go away, so no delegated bearer can outlive the run.
        await stopEnclaveDynamicDelegation(config);
      } catch (error) {
        enclaveAuditComplete = false;
        logger.warn(
          'Dynamic enclave delegation shutdown did not complete; mcpg state may be unreconciled.',
          error,
        );
        if (dockerEnclaves) throw error;
      }
    }
    if (containersStarted) {
      try {
        await shutdownEnclaveGateway(config);
      } catch {
        enclaveAuditComplete = false;
        if (config.enclaves?.enabled) {
          await captureEnclaveStartupDiagnostics(config.workDir, config.proxyLogsDir, 'shutdown-failure');
        }
        logger.warn(
          'Enclave gateway did not complete graceful shutdown; preserved enclave audit is marked incomplete.',
        );
      }
    }
  } finally {
    // VM cancellation/cleanup must complete before disconnecting its peers or
    // tearing down sidecars/networks, even when broker draining fails.
    try {
      await stopCloudHypervisorEnclaveLifecycle(config);
    } finally {
      // Recover broker evidence even when host shutdown must retain resources.
      if (containersStarted) {
        try {
          if (preserveIptablesAudit(config.workDir, config.auditDir) === false) {
            enclaveAuditComplete = false;
            logger.warn('One or more protected enclave audit artifacts could not be preserved.');
          }
        } catch (error) {
          logger.error('Protected audit recovery failed (role=broker-audit, reason=preservation).');
          auditRecoveryFailure = { error };
        }
      }
    }
  }
  if (auditRecoveryFailure) throw auditRecoveryFailure.error;
  if (externalRuntimeCleanupError
    && config.containerRuntime === 'cloud-hypervisor' && config.enclaves?.enabled) {
    throw externalRuntimeCleanupError;
  }
  if (containersStarted) {
    try {
      await disconnectEnclaveGithubGateway(config);
    } catch (error) {
      enclaveAuditComplete = false;
      logger.warn(
        'Compiler-owned shared MCP gateway could not be disconnected cleanly.',
        error,
      );
    }
    if (!enclaveAuditComplete && config.enclaves?.enabled) {
      const targetAuditDir = config.auditDir || path.join(config.workDir, 'audit');
      try {
        writeIncompleteEnclaveAuditMarker(targetAuditDir);
      } catch (error) {
        logger.warn('Failed to write the incomplete enclave audit marker.', error);
      }
    }
    await stopContainers(config.workDir, config.keepContainers);
  }

  if (getHostIptablesSetup() && !config.keepContainers) {
    await cleanupHostIptables();
  }

  // Remove any probe container still labelled with this run and restore
  // write permissions on the immutable seeds. Must run before the generic
  // work-directory cleanup: `rm -rf` cannot unlink entries inside a
  // directory whose write bit was stripped during staging.
  await teardownEnclaves(config);

  if (!config.keepContainers) {
    await cleanup(
      config.workDir,
      false,
      config.proxyLogsDir,
      config.auditDir,
      config.sessionStateDir,
      config.dockerHostPathPrefix,
      config.imageRegistry,
      config.imageTag,
      config.agentImage,
      config.images,
      config.tokenLogDir,
    );
    const resolvedConfigSnapshot = resolvedConfigSnapshots.get(config);
    if (!externalRuntimeCleanupError && resolvedConfigSnapshot !== undefined) {
      const finalAuditDir = config.auditDir ||
        path.join(os.tmpdir(), `awf-audit-${path.basename(config.workDir).replace('awf-', '')}`);
      try {
        publishFinalResolvedConfig(finalAuditDir, resolvedConfigSnapshot);
      } catch (error) {
        logger.warn('Failed to publish finalized resolved config artifact:', error);
      }
    }
    // Note: We don't remove the firewall network here since it can be reused
    // across multiple runs. Cleanup script will handle removal if needed.
  } else {
    logger.info(`Configuration files preserved at: ${config.workDir}`);
    logger.info(`Agent logs available at: ${config.workDir}/agent-logs/`);
    logger.info(`Squid logs available at: ${config.workDir}/squid-logs/`);
    logger.info(`Host iptables rules preserved (--keep-containers enabled)`);
  }
  if (externalRuntimeCleanupError) throw externalRuntimeCleanupError;
}

/**
 * Resolves the Commander option-value source for a given option name.
 * Injected to decouple the action handler from the global program instance,
 * enabling independent unit testing.
 */
type OptionSourceResolver = (optionName: string) => string | undefined;

/**
 * Creates the main `awf` action handler bound to a specific option-source
 * resolver (typically `program.getOptionValueSource.bind(program)`).
 *
 * @param getOptionValueSource - Resolves the Commander source for a flag name
 */
export function createMainAction(getOptionValueSource: OptionSourceResolver) {
  return async function mainAction(args: string[], options: Record<string, unknown>): Promise<void> {
  const reflect = options.reflect === true;

  // Require -- separator for passing command arguments
  if (args.length === 0 && !reflect) {
    console.error('Error: No command specified. Use -- to separate command from options.');
    console.error('Example: awf --allow-domains github.com -- curl https://api.github.com');
    process.exit(1);
  }
  if (reflect && args.length > 0) {
    console.error('Error: --reflect cannot be used with a command.');
    process.exit(1);
  }

  // Command argument handling:
  //
  // SINGLE ARGUMENT (complete shell command):
  //   When a single argument is passed, it's treated as a complete shell
  //   command string. This is CRITICAL for preserving shell variables ($HOME,
  //   $(command), etc.) that must expand in the container, not on the host.
  //
  //   Example: awf -- 'echo $HOME'
  //   → args = ['echo $HOME']  (single element)
  //   → Passed as-is: 'echo $HOME'
  //   → Docker Compose: 'echo $$HOME' (escaped for YAML)
  //   → Container shell: 'echo $HOME' (expands to container home)
  //
  // MULTIPLE ARGUMENTS (shell-parsed by user's shell):
  //   When multiple arguments are passed, each is shell-escaped and joined.
  //   This happens when the user doesn't quote the command.
  //
  //   Example: awf -- curl -H "Auth: token" https://api.github.com
  //   → args = ['curl', '-H', 'Auth: token', 'https://api.github.com']
  //   → joinShellArgs(): curl -H 'Auth: token' https://api.github.com
  //
  // Why not use shell-quote library?
  // - shell-quote expands variables on the HOST ($HOME → /home/hostuser)
  // - We need variables to expand in CONTAINER ($HOME → /root or /home/runner)
  // - The $$$$  escaping pattern requires literal $ preservation
  //
  const agentCommand = reflect
    ? REFLECT_COMMAND
    : args.length === 1 ? args[0] : joinShellArgs(args);

  applyConfigFilePrecedence(options as Record<string, unknown>, getOptionValueSource);

  // Validate all options and assemble the config.
  // Calls process.exit(1) on any validation failure.
  const config = validateOptions(options as Record<string, unknown>, agentCommand);
  if (config.workDir === undefined) {
    config.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-'));
  }
  if (reflect) {
    config.additionalEnv = {
      ...config.additionalEnv,
      AWF_COMMAND_STDOUT_ONLY: '1',
    };
  }

  let exitCode = 0;
  let containersStarted = false;
  let agentCommandStarted = false;
  let hostIptablesSetup = false;
  let externalRuntimeBackend: ExternalAgentRuntimeBackend | undefined;
  let commandOutputCapture: ProtectedCommandOutputCapture | undefined;
  let cloudHypervisorPrimaryPreflightPassed = false;
  let performCleanup = buildCleanupFn(
    config,
    () => containersStarted,
    () => hostIptablesSetup,
  );

  const startupExitState: StartupExitState = {
    startedAt: Date.now(), lastProgressWrite: 'not-attempted', progressWriteFailures: 0,
  };

  try {
    initializeEnclaveStartupProgress(config, () => {
      const outcome = writeStartupFailureDiagnostic(
        config, new Error('Enclave startup in progress'), 'enclave-startup-progress',
        reason => {
          startupExitState.firstProgressWriteFailure ??= reason;
          startupExitState.lastProgressWriteFailure = reason;
        },
      );
      startupExitState.lastProgressWrite = outcome;
      if (outcome !== 'written') {
        startupExitState.progressWriteFailures = Math.min(startupExitState.progressWriteFailures + 1, 999999);
      }
    });
    // Apply --docker-host override for AWF's own container operations.
    // This must be called before startContainers/stopContainers/runAgentCommand.
    setAwfDockerHost(config.awfDockerHost);

    // Auto-detect split filesystem in DinD environments when no explicit prefix is set.
    // This probe runs a lightweight container to check if the daemon can see runner paths.
    if (!config.dockerHostPathPrefix) {
      const probeResult = await probeSplitFilesystem(config.workDir);
      if (probeResult.prefix) {
        config.dockerHostPathPrefix = probeResult.prefix;
        logger.info(`Auto-applied --docker-host-path-prefix ${probeResult.prefix} (DinD split filesystem detected)`);
      } else if (probeResult.splitDetected) {
        logger.warn(
          '⚠️  Split runner/daemon filesystem detected but no known prefix worked. ' +
          'Set --docker-host-path-prefix manually if bind mounts fail.',
        );
      }

      await runDindBootstrap(config);
    }
    assertPersistentDebugArtifactsIsolated(config);
    commandOutputCapture = prepareProtectedCommandOutputCapture(config);
    if (commandOutputCapture) {
      config.additionalEnv = {
        ...config.additionalEnv,
        AWF_CAPTURE_COMMAND_OUTPUT: '1',
      };
    }

    // Log config with redacted secrets - remove API keys entirely
    // to prevent sensitive data from flowing to logger (CodeQL sensitive data logging)
    const redactedConfig = redactConfigForLogging(config);
    logger.debug('Configuration:', JSON.stringify(redactedConfig, null, 2));

    logger.info(`Allowed domains: ${config.allowedDomains.join(', ')}`);
    if (config.blockedDomains && config.blockedDomains.length > 0) {
      logger.info(`Blocked domains: ${config.blockedDomains.join(', ')}`);
    }
    logger.debug(`DNS servers: ${(config.dnsServers ?? []).join(', ')}`);

    updateEnclaveStartupProgress(config, { stage: 'runtime-preflight' });
    externalRuntimeBackend = resolveExternalRuntimeBackend(config, startContainers);
    performCleanup = buildCleanupFn(
      config,
      () => containersStarted,
      () => hostIptablesSetup,
      externalRuntimeBackend,
    );

    // Register signal handlers for graceful shutdown
    registerSignalHandlers({
      getContainersStarted: () => containersStarted,
      keepContainers: config.keepContainers,
      fastKillAgentContainer: async () => {
        if (externalRuntimeBackend) {
          await externalRuntimeBackend.stop();
        } else {
          await fastKillAgentContainer();
        }
        if (commandOutputCapture) {
          if (agentCommandStarted) {
            await commandOutputCapture.waitForCommandCompletion();
          } else {
            commandOutputCapture.finishCommand(undefined, 'cancelled');
          }
        }
      },
      performCleanup: async (signal) => {
        try {
          await performCleanup(signal);
          commandOutputCapture?.setTeardown('complete');
        } catch (error) {
          commandOutputCapture?.setTeardown('failed');
          throw error;
        } finally {
          if (signal) {
            commandOutputCapture?.finishCommand(
              undefined,
              config.keepContainers && agentCommandStarted ? 'interrupted' : 'cancelled',
            );
          }
          commandOutputCapture?.close();
        }
      },
      cleanupRouting: () => cleanupRoutingState(config),
    });

    if (externalRuntimeBackend) {
      try {
        if (config.enclaves?.enabled && externalRuntimeBackend.runtime === 'cloud-hypervisor') {
          const checks = new HostPreflightReporter('enclave-runtime', (hostPreflight) =>
            updateEnclaveStartupProgress(config, { hostPreflight }));
          await checks.check('primary-runtime', () => externalRuntimeBackend!.preflight());
          cloudHypervisorPrimaryPreflightPassed = true;
        } else {
          await externalRuntimeBackend.preflight();
        }
      } catch (error) {
        if (
          externalRuntimeBackend.runtime === 'cloud-hypervisor' &&
          !config.enclaves?.enabled &&
          isCloudHypervisorUnsupportedHostError(error)
        ) {
          logger.warn(formatCloudHypervisorDockerFallbackWarning(error));
          config.containerRuntime = undefined;
          config.cloudHypervisor = undefined;
          externalRuntimeBackend = undefined;
          performCleanup = buildCleanupFn(
            config,
            () => containersStarted,
            () => hostIptablesSetup,
          );
        } else {
          throw error;
        }
      }
    }

    // Persist only after preflight so the audit artifact records the effective
    // runtime when an unsupported Cloud Hypervisor host falls back to Docker.
    persistConfigAuditArtifact(config, redactConfigForLogging(config));

    const externalWorkflowDependencies = externalRuntimeBackend
      ? adaptExternalRuntimeBackend(externalRuntimeBackend)
      : undefined;
    const workflowRunAgentCommand = externalWorkflowDependencies?.runAgentCommand
      ?? ((
        workDir: string,
        allowedDomains: string[],
        proxyLogsDir?: string,
        agentTimeoutMinutes?: number,
        capture?: ProtectedCommandOutputCapture,
      ) => capture
        ? runAgentCommand(
          workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, config.containerRuntime, capture,
        )
        : runAgentCommand(
          workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, config.containerRuntime,
        ));
    const trackedRunAgentCommand = async (
      workDir: string,
      allowedDomains: string[],
      proxyLogsDir?: string,
      agentTimeoutMinutes?: number,
      capture?: ProtectedCommandOutputCapture,
    ) => {
      agentCommandStarted = true;
      const result = capture
        ? await workflowRunAgentCommand(
          workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, capture,
        )
        : await workflowRunAgentCommand(workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes);
      if (result.exitCode !== 0) {
        emitStartupExitMarker(config, startupExitState, {
          path: 'workflow-return', exitCode: result.exitCode, containersStarted,
          agentStarted: agentCommandStarted, recordWrite: 'not-attempted', cleanup: 'pending',
        });
      }
      return result;
    };
    const diagnosticRuntimeBackend = externalRuntimeBackend;
    const workflowCollectDiagnosticLogs = diagnosticRuntimeBackend
      ? async (workDir: string): Promise<void> => {
         const results = await Promise.allSettled([
           diagnosticRuntimeBackend.collectDiagnostics(),
           collectDiagnosticLogs(workDir),
         ]);
         const failures = results.filter(
           (result): result is PromiseRejectedResult => result.status === 'rejected',
         );
         if (failures.length > 0) {
           throw new Error(
             failures.map((failure) => (
               failure.reason instanceof Error
                 ? failure.reason.message
                 : String(failure.reason)
             )).join('; '),
           );
         }
        }
      : collectDiagnosticLogs;

    exitCode = await runMainWorkflow(
      config,
      {
        ensureFirewallNetwork,
        setupHostIptables,
        writeConfigs,
        startContainers: externalWorkflowDependencies?.startContainers ?? startContainers,
        runAgentCommand: trackedRunAgentCommand,
        collectDiagnosticLogs: workflowCollectDiagnosticLogs,
        assertTopologySupported,
        connectTopologyContainers,
        connectEnclaveGateway,
        assertEnclaveGatewayReady,
        connectEnclaveGithubGateway,
        assertEnclaveGithubGatewayReady,
        prepareEnclaves: config.enclaves?.enabled
          && externalRuntimeBackend?.runtime === 'cloud-hypervisor'
          ? async (candidate) => {
            if (candidate !== config) {
              throw new Error('Cloud Hypervisor primary runtime preflight evidence is unavailable for this run');
            }
            return prepareEnclaves(candidate, {
              assertCloudHypervisorPrimaryPreflight: async (preflightConfig) => {
                if (
                  preflightConfig !== config
                  || config.containerRuntime !== 'cloud-hypervisor'
                  || externalRuntimeBackend?.runtime !== 'cloud-hypervisor'
                  || !cloudHypervisorPrimaryPreflightPassed
                ) {
                  throw new Error('Cloud Hypervisor primary runtime preflight evidence is unavailable for this run');
                }
              },
            });
          }
          : prepareEnclaves,
        startEnclaveDynamicDelegation,
        prepareRouting: async (routingConfig) => stageRoutingConversation(routingConfig),
        waitForRoutingSelection,
        verifyRoutingCompletion: async (routingState) => verifyRoutingCompletion(routingState),
        cleanupRouting: async (routingConfig) => cleanupRoutingState(routingConfig),
      },
      {
        logger,
        performCleanup: async () => {
          try {
            await performCleanup();
            commandOutputCapture?.setTeardown('complete');
          } catch (error) {
            commandOutputCapture?.setTeardown('failed');
            throw error;
          }
        },
        commandOutputCapture,
        onHostIptablesSetup: () => {
          hostIptablesSetup = true;
        },
        onContainersStarted: () => {
          containersStarted = true;
        },
      }
    );

    if (exitCode !== 0) {
      emitStartupExitMarker(config, startupExitState, {
        path: 'workflow-return', exitCode, containersStarted, agentStarted: agentCommandStarted,
        recordWrite: 'not-attempted', cleanup: 'completed',
      });
    }
    commandOutputCapture?.close();
    console.error(`Process exiting with code: ${exitCode}`);
    process.exit(exitCode);
    return;
  } catch (error) {
    logger.error('Fatal error:', error);
    let recordWriteReason: StartupDiagnosticWriteReason | null = null;
    const recordWrite: StartupDiagnosticWriteOutcome = agentCommandStarted
      ? 'not-attempted'
      : writeStartupFailureDiagnostic(config, error, 'startup', reason => { recordWriteReason = reason; });
    const plannedExitCode = findRoutingFailure(error)?.exitCode ?? 1;
    const exitMarker = {
      path: 'fatal' as const, exitCode: plannedExitCode, containersStarted,
      agentStarted: agentCommandStarted, recordWrite, recordWriteReason,
    };
    // Emit before cleanup too, so a hung or crashing teardown still leaves evidence.
    emitStartupExitMarker(config, startupExitState, { ...exitMarker, cleanup: 'pending' });
    let cleanupOutcome: 'completed' | 'failed' = 'completed';
    try {
      await performCleanup();
    } catch (cleanupError) {
      cleanupOutcome = 'failed';
      logger.warn('Cleanup after a fatal error failed.', cleanupError);
    }
    if (commandOutputCapture) {
      commandOutputCapture.finishCommand(
        undefined,
        'failed',
      );
      commandOutputCapture.setTeardown(cleanupOutcome === 'completed' ? 'complete' : 'failed');
      commandOutputCapture.close();
    }
    emitStartupExitMarker(config, startupExitState, { ...exitMarker, cleanup: cleanupOutcome });
    cleanupRoutingState(config);
    const fatalExitCode = findRoutingFailure(error)?.exitCode ?? 1;
    console.error(`Process exiting with code: ${fatalExitCode}`);
    process.exit(fatalExitCode);
  }
  };
}

/** @internal Exposed for unit tests. */
// ts-prune-ignore-next
export const testHelpers = {
  redactConfigForLogging,
  persistConfigAuditArtifact,
  writeStartupFailureDiagnostic,
  emitStartupExitMarker,
  startupElapsedBucket,
  writeIncompleteEnclaveAuditMarker,
  buildCleanupFn,
};
