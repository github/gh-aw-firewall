/**
 * Apple Container external agent runtime backend.
 *
 * Docker Compose keeps owning AWF's infrastructure (Squid, the API proxy, the
 * CLI proxy); only the agent crosses the hypervisor boundary, into an Apple
 * Virtualization.framework VM launched by the `container` CLI. Three properties
 * define the shape of this file, and every ordering decision follows from them:
 *
 * 1. **The VM has no NIC.** Every launch emits `--network none` — layer 1
 *    defaults to it, layer 2 re-asserts it, and layer 1 always emits the flag
 *    explicitly because omitting `--network` attaches Apple's default vmnet
 *    network. There is therefore no in-guest firewall to configure and no
 *    iptables-init container: egress exists only where a capability socket was
 *    published.
 * 2. **The transport is mandatory.** Proxy environment variables are advisory
 *    and Apple Container has no forced-proxy daemon setting, so a guest whose
 *    relay failed would simply have no egress rather than an unfiltered one.
 *    That is safe, but useless, so transport startup and end-to-end verification
 *    are fatal on failure and always precede agent launch.
 * 3. **Nothing falls back.** An ineligible host, an unsupported `container` CLI,
 *    an occupied loopback port, or a failed image pull aborts the run. There is
 *    no silent degradation to Docker.
 *
 * Startup order (each step's failure rolls back everything before it):
 *
 * ```
 *   compatibility → Apple host/CLI/service preflight → transport CLI version
 *   → loopback port availability → Compose infrastructure (infra services only)
 *   → run directories → image pull (agent + init, native arm64)
 *   → transport start + verify → container create
 * ```
 */

import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import type { WorkflowDependencies } from './cli-workflow';
import type { ExternalAgentRuntimeBackend } from './external-runtime-backend';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { logger } from './logger';
import { resolveRuntimeImageFor } from './image-resolver';
import { resolveLogPaths } from './log-paths';
import type { AppleContainerOptions, WrapperConfig } from './types';
import {
  appleContainerRunDirectories,
  buildAppleContainerAgentSpec,
  type AppleContainerRunDirectories,
} from './apple-container/agent-run-spec';
import { AppleContainerCli, type AppleContainerCliOptions } from './apple-container/cli';
import {
  collectAppleContainerDiagnostics,
  type AppleContainerDiagnostics,
} from './apple-container/diagnostics';
import {
  appleContainerLoopbackPortConflicts,
  planAppleContainerInfrastructure,
  type AppleContainerInfrastructurePlan,
} from './apple-container/infrastructure-endpoints';
import { AppleContainerLifecycle } from './apple-container/lifecycle';
import {
  runAppleContainerPreflight,
  type AppleContainerPreflightResult,
} from './apple-container/preflight';
import type { AppleContainerRunSpec } from './apple-container/run-args';
import {
  APPLE_CONTAINER_RUNTIME,
  assertAppleContainerRuntimeCompatibility,
  requireAppleContainerConfig,
} from './apple-container/runtime-validation';
import { assertAppleContainerTransportCliVersion } from './apple-container/transport-capabilities';
import {
  startAppleContainerTransport,
  type AppleContainerTransport,
} from './apple-container/transport-manager';
import { assertAppleContainerImageReference } from './apple-container/validation';

export {
  assertAppleContainerPreSecurityCompatibility,
  assertAppleContainerRuntimeCompatibility,
  assertAppleContainerSelection,
} from './apple-container/runtime-validation';

/** Exit code for an agent cut off by `--agent-timeout` (coreutils convention). */
export const APPLE_CONTAINER_TIMEOUT_EXIT_CODE = 124;

/** Grace period for `container stop` before the CLI escalates to a kill. */
const APPLE_CONTAINER_STOP_TIMEOUT_SECONDS = 10;

/** Guest platform. Native arm64 only; Rosetta translation is never requested. */
const APPLE_CONTAINER_PLATFORM = 'linux/arm64';

/**
 * Base directory for the run-scoped capability socket directory.
 *
 * Deliberately *not* `workDir`. macOS caps `sun_path` at 104 bytes, and a
 * realistic runner work directory blows that budget: on a self-hosted runner
 * `${RUNNER_TEMP}/awf-<timestamp>/apple-container/awf-apple-<runid>/
 * api-proxy-anthropic.sock` is well over 110 bytes, so the socket could not be
 * bound at all. `os.tmpdir()` is not reliably better — an Actions runner's
 * `TMPDIR` is typically a ~49-byte `/var/folders/...` path, which leaves only a
 * couple of spare bytes.
 *
 * `/tmp` resolves to `/private/tmp` on macOS (13 bytes), which leaves ample
 * room. Its world-writable sticky permissions are not a weakness here because
 * `createAppleContainerSocketDirectory` is built for exactly this setting: the
 * run directory is created with a non-recursive `mkdir` (so a pre-existing or
 * planted path is a hard failure, never a reuse), forced to `0700`, and then
 * verified for real-directory type, ownership, mode, and self-resolution before
 * any socket is bound — and binding never unlinks, so a squatted socket path
 * fails closed rather than being taken over.
 */
const APPLE_CONTAINER_TRANSPORT_BASE_DIRECTORY = '/tmp';

interface AppleContainerBackendLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** The two images a launch needs, both native arm64. */
export interface AppleContainerImages {
  readonly agent: string;
  readonly init: string;
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export interface AppleContainerRuntimeBackendDependencies {
  startInfrastructure: WorkflowDependencies['startContainers'];
  preflight(options: AppleContainerCliOptions): Promise<AppleContainerPreflightResult>;
  createLifecycle(options: AppleContainerCliOptions): AppleContainerLifecycle;
  startTransport: typeof startAppleContainerTransport;
  collectDiagnostics: typeof collectAppleContainerDiagnostics;
  findPortConflicts: typeof appleContainerLoopbackPortConflicts;
  /** Confirms an image is already present in Apple Container's own image store. */
  imagePresent(lifecycle: AppleContainerLifecycle, reference: string): Promise<boolean>;
  ensureDirectory(directory: string): Promise<void>;
  writeDiagnostics(directory: string, diagnostics: AppleContainerDiagnostics): Promise<void>;
  identity(): { uid: string; gid: string };
  workspaceDir(): string;
  ghAwStateDir(): string | undefined;
  resolveImages(config: WrapperConfig, appleContainer: AppleContainerOptions): AppleContainerImages;
  /** Short base directory for the capability sockets; see the constant's comment. */
  transportBaseDirectory(): string;
  logger: AppleContainerBackendLogger;
}

/**
 * Resolves the digest-pinned, native arm64 image pair.
 *
 * Both references must be digest-pinned. A floating tag would let the registry
 * decide what runs inside the VM between the operator's decision and the launch,
 * and — unlike the Docker path, where a mutable tag at least stays inside the
 * daemon's content trust story — Apple Container maintains a *separate* image
 * store, so a tag resolved here has no relationship to anything Docker pulled.
 */
function defaultResolveImages(
  config: WrapperConfig,
  appleContainer: AppleContainerOptions,
): AppleContainerImages {
  const agent = resolveRuntimeImageFor(config, 'agent');
  const init = appleContainer.initImage ?? resolveRuntimeImageFor(config, 'apple-init');
  return {
    agent: assertDigestPinned(assertAppleContainerImageReference(agent), 'agent'),
    init: assertDigestPinned(assertAppleContainerImageReference(init), 'apple-init'),
  };
}

function assertDigestPinned(reference: string, role: string): string {
  if (!/@sha256:[a-f0-9]{64}$/.test(reference)) {
    throw new Error(
      `Apple Container requires a digest-pinned ${role} image; got "${reference}". ` +
      'Supply container.images or an --image-tag carrying the digest, because Apple ' +
      "Container's image store is independent of Docker's and cannot inherit a pre-pull.",
    );
  }
  return reference;
}

async function defaultImagePresent(
  lifecycle: AppleContainerLifecycle,
  reference: string,
): Promise<boolean> {
  const result = await lifecycle.cli.run([
    'image',
    'inspect',
    assertAppleContainerImageReference(reference),
  ]);
  return result.exitCode === 0;
}

async function defaultWriteDiagnostics(
  directory: string,
  diagnostics: AppleContainerDiagnostics,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  for (const capture of diagnostics.captures) {
    // A successful JSON capture is written verbatim so it stays machine-
    // readable; everything else (and any failed capture, whose body is an
    // error message rather than JSON) carries a provenance header.
    const body = capture.ok && capture.name.endsWith('.json')
      ? `${capture.content}\n`
      : `# ${capture.argv.join(' ')}\n# ok=${capture.ok}\n\n${capture.content}\n`;
    await fs.writeFile(path.join(directory, capture.name), body, { mode: 0o600 });
  }
}

function defaultDependencies(
  startInfrastructure: WorkflowDependencies['startContainers'],
): AppleContainerRuntimeBackendDependencies {
  return {
    startInfrastructure,
    preflight: (options) => runAppleContainerPreflight({ cli: options }),
    createLifecycle: (options) => new AppleContainerLifecycle(new AppleContainerCli(options)),
    startTransport: startAppleContainerTransport,
    collectDiagnostics: collectAppleContainerDiagnostics,
    findPortConflicts: appleContainerLoopbackPortConflicts,
    imagePresent: defaultImagePresent,
    ensureDirectory: async (directory) => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    },
    writeDiagnostics: defaultWriteDiagnostics,
    identity: () => ({ uid: getSafeHostUid(), gid: getSafeHostGid() }),
    workspaceDir: () => process.env.GITHUB_WORKSPACE || process.cwd(),
    ghAwStateDir: () => {
      const runnerTemp = process.env.RUNNER_TEMP;
      if (!runnerTemp) return undefined;
      const candidate = path.join(runnerTemp, 'gh-aw');
      // Only mounted when the runner actually created it. Creating it here
      // would hand the guest a writable directory the workflow never asked for.
      return fsSync.existsSync(candidate) ? candidate : undefined;
    },
    resolveImages: defaultResolveImages,
    transportBaseDirectory: () => APPLE_CONTAINER_TRANSPORT_BASE_DIRECTORY,
    logger,
  };
}

/**
 * Stateful adapter for the Apple Container preview runtime.
 *
 * @internal Production code obtains instances via
 * {@link createAppleContainerRuntimeBackend}; the class is exported only so
 * unit tests can construct it with injected dependencies.
 */
// ts-prune-ignore-next
export class AppleContainerRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = APPLE_CONTAINER_RUNTIME;

  private preflightResult: AppleContainerPreflightResult | undefined;
  private lifecycle: AppleContainerLifecycle | undefined;
  private transport: AppleContainerTransport | undefined;
  private infrastructurePlan: AppleContainerInfrastructurePlan | undefined;
  private directories: AppleContainerRunDirectories | undefined;
  private spec: AppleContainerRunSpec | undefined;
  private containerId: string | undefined;
  private diagnosticsCollected = false;
  private preservedTransportDirectory: string | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: AppleContainerRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    const appleContainer = requireAppleContainerConfig(this.config);
    assertAppleContainerRuntimeCompatibility(this.config, appleContainer);

    const result = await this.dependencies.preflight(this.cliOptions(appleContainer));
    // The init image relocates Apple's real `vminitd`, so a CLI outside the
    // validated window could boot a guest whose init layout the shim does not
    // match — which would surface as a VM with no capabilities rather than as a
    // failure. Refuse before anything is created.
    assertAppleContainerTransportCliVersion(result.cliVersion);
    this.preflightResult = result;

    const plan = planAppleContainerInfrastructure(this.config);
    this.infrastructurePlan = plan;
    const conflicts = await this.dependencies.findPortConflicts(plan);
    if (conflicts.length > 0) {
      throw new Error(
        'Apple Container requires these macOS loopback ports for its capability relays, but ' +
        `something is already listening on them: ${
          conflicts.map((entry) => `${entry.hostPort} (${entry.capability})`).join(', ')
        }. Stop the conflicting process or the previous AWF run and retry.`,
      );
    }

    this.dependencies.logger.info(
      `[apple-container] runtime=${APPLE_CONTAINER_RUNTIME} maturity=preview fallback=disabled ` +
      `cli=${result.cliVersion} macos=${result.facts.macosProductVersion} arch=${result.facts.arch}`,
    );
  }

  readonly start: WorkflowDependencies['startContainers'] = async (
    workDir,
    allowedDomains,
    proxyLogsDir,
    skipPull,
    onNetworkReady,
    onInfrastructureReady,
  ) => {
    const appleContainer = requireAppleContainerConfig(this.config);
    let stage = 'preflight';
    try {
      await this.preflight();
      const plan = this.infrastructurePlan!;

      stage = 'compose-infrastructure';
      // Compose generates infrastructure services only for this runtime
      // (`runtimeUsesComposeAgent` is false), so no agent or iptables-init
      // container is created and the required ports are published to macOS
      // loopback by `applyAppleContainerLoopbackPublishing`.
      await this.dependencies.startInfrastructure(
        workDir,
        allowedDomains,
        proxyLogsDir,
        skipPull,
        onNetworkReady,
        onInfrastructureReady,
      );

      stage = 'run-directories';
      this.directories = appleContainerRunDirectories(workDir);
      await this.prepareDirectories(this.directories);

      stage = 'image-pull';
      this.lifecycle = this.dependencies.createLifecycle(this.cliOptions(appleContainer));
      const images = this.dependencies.resolveImages(this.config, appleContainer);
      await this.ensureImages(images, skipPull === true);

      stage = 'transport';
      this.transport = await this.dependencies.startTransport({
        capabilities: plan.capabilities,
        initImage: images.init,
        baseDirectory: this.dependencies.transportBaseDirectory(),
      });
      this.dependencies.logger.info(
        `[apple-container] capability transport ready: ${
          plan.capabilities.map((capability) => capability.id).join(', ')
        }`,
      );

      stage = 'container-create';
      // Resolved once: the default implementation stats the filesystem, and a
      // directory that appeared between two calls would produce a spec whose
      // mounts disagree with the check that authorised them.
      const ghAwStateDir = this.dependencies.ghAwStateDir();
      const spec = this.transport.applyTo(buildAppleContainerAgentSpec({
        config: this.config,
        directories: this.directories,
        workspaceDir: this.dependencies.workspaceDir(),
        ...(ghAwStateDir !== undefined ? { ghAwStateDir } : {}),
        image: images.agent,
        name: appleContainerName(),
        cpus: appleContainer.cpus,
        memory: appleContainer.memory,
        identity: this.dependencies.identity(),
      }));
      assertIsolatedSpec(spec);
      this.spec = spec;
      this.containerId = await this.lifecycle.create(spec);
      this.dependencies.logger.info(
        `[apple-container] stage=ready container=${this.containerId}`,
      );
    } catch (error) {
      this.dependencies.logger.warn(
        `[apple-container] stage=${stage} status=failed: ${describe(error)}`,
      );
      // Partial startup must not leave a VM or a live capability socket behind;
      // the original error is always what propagates.
      await this.rollback();
      throw error;
    }
  };

  readonly exec: WorkflowDependencies['runAgentCommand'] = async (
    _workDir,
    _allowedDomains,
    _proxyLogsDir,
    agentTimeoutMinutes,
  ) => {
    const lifecycle = this.lifecycle;
    const containerId = this.containerId;
    if (!lifecycle || !containerId || !this.transport) {
      throw new Error('Apple Container agent VM is not ready');
    }

    const timeoutMs = agentTimeoutMinutes === undefined
      ? undefined
      : agentTimeoutMinutes * 60_000;
    this.dependencies.logger.info(
      `[apple-container] Launching agent in ${containerId} ` +
      `(timeout: ${agentTimeoutMinutes ?? 'none'} min)`,
    );

    const result = await lifecycle.startAttached(containerId, {
      interactive: true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

    if (result.timedOut) {
      // execa killed the attached `container start` client, not the VM. Kill the
      // guest explicitly so the run cannot outlive its own timeout.
      this.dependencies.logger.warn(
        `[apple-container] Agent exceeded --agent-timeout; killing ${containerId}`,
      );
      try {
        await lifecycle.kill(containerId);
      } catch (error) {
        this.dependencies.logger.warn(
          `[apple-container] Could not kill ${containerId} after timeout: ${describe(error)}`,
        );
      }
      return { exitCode: APPLE_CONTAINER_TIMEOUT_EXIT_CODE };
    }

    this.dependencies.logger.info(
      `[apple-container] Agent command exited with code ${result.exitCode}` +
      (result.signal ? ` (${result.signal})` : ''),
    );
    return { exitCode: result.exitCode };
  };

  async collectDiagnostics(): Promise<void> {
    if (this.diagnosticsCollected || !this.lifecycle) return;
    this.diagnosticsCollected = true;

    const directory = this.config.auditDir
      ? path.join(this.config.auditDir, 'apple-container')
      : path.join(this.config.workDir, 'diagnostics', 'apple-container');

    const diagnostics = await this.dependencies.collectDiagnostics(this.lifecycle.cli, {
      ...(this.containerId !== undefined ? { containerId: this.containerId } : {}),
    });

    const captures = diagnostics.captures.map(redactAppleContainerCapture);
    if (this.transport) {
      // Counters only: ids, guest ports, upstreams, and byte/connection totals.
      // The relay retains no payload, so nothing here can carry credential
      // material out of the API proxy sidecar.
      captures.push({
        name: 'transport-stats.json',
        argv: [],
        ok: true,
        content: JSON.stringify(this.transport.stats(), null, 2),
      });
    }
    await this.dependencies.writeDiagnostics(directory, { captures });
    this.dependencies.logger.info(`[apple-container] Diagnostics written to ${directory}`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopping) return this.stopping;
    this.stopping = this.runStop(false);
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
    this.stopping = this.runStop(true);
    try {
      await this.stopping;
      this.stopped = true;
      if (this.directories) {
        this.dependencies.logger.info(
          `[apple-container] Preserved run directory: ${this.directories.root}`,
        );
      }
      if (this.containerId) {
        this.dependencies.logger.info(
          `[apple-container] Preserved container: ${this.containerId} ` +
          '(inspect with "container inspect"; remove with "container delete")',
        );
      }
      if (this.preservedTransportDirectory) {
        // Named explicitly because it lives outside workDir (see
        // APPLE_CONTAINER_TRANSPORT_BASE_DIRECTORY) and would otherwise be
        // missed during triage. Its sockets are already unlinked; only the
        // summary remains.
        this.dependencies.logger.info(
          `[apple-container] Preserved transport summary: ` +
          `${this.preservedTransportDirectory}/transport-summary.json`,
        );
      }
    } finally {
      this.stopping = undefined;
    }
  }

  /**
   * Teardown.
   *
   * The guest is quiesced before the transport is torn down so a still-running
   * workload never observes its capabilities disappearing mid-request. Under
   * `preserve` the container is stopped but kept for inspection, while the
   * transport still unlinks every socket — a preserved run must never leave an
   * active path into AWF's credential-injecting sidecar.
   */
  private async runStop(preserve: boolean): Promise<void> {
    const failures: string[] = [];

    if (this.lifecycle && this.containerId) {
      try {
        await this.lifecycle.stop(this.containerId, {
          timeoutSeconds: APPLE_CONTAINER_STOP_TIMEOUT_SECONDS,
        });
      } catch (error) {
        // Already-exited is the common case here and is not an error worth
        // surfacing; a genuinely stuck VM is escalated by the kill below.
        this.dependencies.logger.debug(
          `[apple-container] stop(${this.containerId}) reported: ${describe(error)}`,
        );
        try {
          await this.lifecycle.kill(this.containerId);
        } catch {
          // The container may already be gone; removal below is authoritative.
        }
      }
      if (!preserve) {
        try {
          await this.lifecycle.remove(this.containerId, { force: true });
          this.containerId = undefined;
        } catch (error) {
          failures.push(`container removal: ${describe(error)}`);
        }
      }
    }

    if (this.transport) {
      if (preserve) {
        this.preservedTransportDirectory = this.transport.directory.path;
      }
      try {
        await this.transport.stop({ preserveDiagnostics: preserve });
      } catch (error) {
        failures.push(`transport shutdown: ${describe(error)}`);
      }
      this.transport = undefined;
    }

    if (failures.length > 0) {
      throw new Error(`Apple Container teardown failed: ${failures.join('; ')}`);
    }
  }

  /** Best-effort undo of a partial `start()`; never masks the original error. */
  private async rollback(): Promise<void> {
    try {
      await this.runStop(false);
    } catch (error) {
      this.dependencies.logger.warn(
        `[apple-container] rollback did not fully complete: ${describe(error)}`,
      );
    }
    this.stopped = true;
  }

  private cliOptions(appleContainer: AppleContainerOptions): AppleContainerCliOptions {
    return appleContainer.cliPath ? { binary: appleContainer.cliPath } : {};
  }

  /**
   * Creates the run-scoped host directories, plus the `.copilot` mountpoints the
   * nested log mounts land on. A missing mountpoint inside a virtiofs share is a
   * boot failure, so they are created here rather than discovered later.
   */
  private async prepareDirectories(directories: AppleContainerRunDirectories): Promise<void> {
    const logPaths = resolveLogPaths(this.config);
    for (const directory of [
      directories.root,
      directories.home,
      directories.tmp,
      directories.homeCopilotLogs,
      directories.homeCopilotSessionState,
      logPaths.agentLogs,
      logPaths.sessionState,
    ]) {
      await this.dependencies.ensureDirectory(directory);
    }
  }

  /**
   * Populates Apple Container's image store.
   *
   * `--skip-pull` cannot be honoured by assumption: Apple Container keeps its
   * own image store, so a Docker pre-pull (including the one `setup-awf` does)
   * leaves it empty. Presence is therefore *verified*, and a missing image is an
   * error naming the exact `container image pull` command to run.
   */
  private async ensureImages(images: AppleContainerImages, skipPull: boolean): Promise<void> {
    const lifecycle = this.lifecycle!;
    for (const [role, reference] of Object.entries(images) as [keyof AppleContainerImages, string][]) {
      if (skipPull) {
        if (!await this.dependencies.imagePresent(lifecycle, reference)) {
          throw new Error(
            `--skip-pull was requested but the ${role} image ${reference} is not in Apple ` +
            "Container's image store, which is independent of Docker's. Run " +
            `"container image pull --platform ${APPLE_CONTAINER_PLATFORM} ${reference}" first.`,
          );
        }
        this.dependencies.logger.debug(
          `[apple-container] ${role} image already present: ${reference}`,
        );
        continue;
      }
      this.dependencies.logger.info(`[apple-container] Pulling ${role} image ${reference}`);
      await lifecycle.pullImage(reference, { platform: APPLE_CONTAINER_PLATFORM });
    }
  }
}

/**
 * Keys whose value is an environment block in `container inspect` output.
 *
 * Apple Container serialises the guest's full environment under
 * `initProcess.environment`. Persisting that verbatim would be a real leak:
 * `artifact-preservation` widens the whole audit directory to `a+rX` and CI
 * routinely uploads it, and while `applySecurityMode` forces the API proxy on
 * (so provider keys are placeholders), a workflow can still legitimately place
 * its own secrets in the agent environment. Both existing runtimes already
 * refuse to capture env — `diagnostic-collector.ts` documents its Docker
 * capture as "no env vars", and the Cloud Hypervisor collector captures only
 * logs, counters, and the network plan — so this keeps the contract rather than
 * quietly widening it.
 */
const ENVIRONMENT_KEYS = new Set(['environment', 'env']);

/**
 * Replaces every environment block with its variable *names*.
 *
 * Names are what triage actually needs ("was `ANTHROPIC_BASE_URL` set?"), and
 * they carry no secret material. Accepts both the array-of-`KEY=VALUE` and the
 * object shapes so a future CLI change cannot slip values through by switching
 * representation.
 */
function redactEnvironmentBlocks(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactEnvironmentBlocks);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!ENVIRONMENT_KEYS.has(key.toLowerCase())) {
      result[key] = redactEnvironmentBlocks(nested);
      continue;
    }
    result[key] = `[REDACTED: ${environmentNames(nested).join(', ')}]`;
  }
  return result;
}

function environmentNames(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.split('=', 1)[0]);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/**
 * Redacts a single capture before it is persisted.
 *
 * Only the container inspect capture can carry an environment block. A capture
 * whose JSON cannot be parsed is replaced entirely rather than written through:
 * an unparseable body is exactly the case where a value could survive
 * unredacted, so it fails closed and says so.
 */
function redactAppleContainerCapture(
  capture: AppleContainerDiagnostics['captures'][number],
): AppleContainerDiagnostics['captures'][number] {
  if (capture.name !== 'container-inspect.json' || !capture.ok) {
    return capture;
  }
  try {
    const parsed: unknown = JSON.parse(capture.content);
    return {
      ...capture,
      content: JSON.stringify(redactEnvironmentBlocks(parsed), null, 2),
    };
  } catch {
    return {
      ...capture,
      ok: false,
      content:
        '(withheld) "container inspect" output could not be parsed as JSON, so its guest ' +
        'environment block could not be redacted; the capture is dropped rather than persisted.',
    };
  }
}

/**
 * Last-line assertion before a container is created.
 *
 * Layer 1 defaults to `--network none` and layer 2's merge re-emits it, so this
 * can only fail if one of those invariants regressed. It is checked anyway
 * because the failure mode — a VM silently attached to Apple's default vmnet
 * network, with full unfiltered egress — is exactly the one that would not
 * announce itself.
 */
function assertIsolatedSpec(spec: AppleContainerRunSpec): void {
  if (!spec.network || spec.network.kind !== 'none') {
    throw new Error(
      'Apple Container refuses to create an agent VM without --network none; omitting it ' +
      'attaches the default vmnet network and gives the agent unfiltered egress',
    );
  }
  if (spec.capAdd && spec.capAdd.length > 0) {
    throw new Error(
      `Apple Container refuses to create an agent VM with added capabilities: ${spec.capAdd.join(', ')}`,
    );
  }
  if ((spec.arch ?? 'arm64') !== 'arm64') {
    throw new Error(
      `Apple Container supports native arm64 guests only; got ${spec.arch}. Rosetta translation ` +
      'is never used.',
    );
  }
}

/**
 * Run-scoped container name.
 *
 * Distinct per run so a leftover VM from a previous run cannot be adopted, and
 * so `container list` attributes a VM to the process that made it.
 */
function appleContainerName(): string {
  return `awf-agent-${process.pid}-${Date.now()}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAppleContainerRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): AppleContainerRuntimeBackend {
  return new AppleContainerRuntimeBackend(config, defaultDependencies(startInfrastructure));
}

/** @internal Exposed only for focused default-dependency tests. */
// ts-prune-ignore-next
export const appleContainerRuntimeTestHelpers = {
  APPLE_CONTAINER_TRANSPORT_BASE_DIRECTORY,
  redactAppleContainerCapture,
  defaultDependencies,
  defaultResolveImages,
  defaultImagePresent,
  assertIsolatedSpec,
  appleContainerName,
};
