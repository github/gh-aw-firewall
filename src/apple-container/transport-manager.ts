/**
 * Lifecycle owner for the Apple Container capability transport.
 *
 * Startup is strictly ordered and fails closed at every step:
 *
 * 1. **Plan.** The capability set is validated against the allowlist before any
 *    filesystem or network side effect happens.
 * 2. **Upstream health.** Every upstream is TCP-probed first. Relays are only
 *    bound once the services they front are actually accepting connections, so
 *    a guest can never observe a socket that leads nowhere.
 * 3. **Private directory.** A fresh `0700` run directory is created.
 * 4. **Bind.** Relays are started one at a time.
 * 5. **End-to-end verification.** Each relay is probed through its own Unix
 *    socket, which exercises accept → dial → establish. Only after every
 *    capability passes is the transport declared ready.
 *
 * Any failure at any step triggers a full rollback: every relay that was
 * started is stopped, its socket is unlinked, the run directory is removed, and
 * the *original* error propagates. The transport is never returned in a partial
 * state, so a caller that awaits {@link startAppleContainerTransport} and gets a
 * value knows the agent may start; if it throws, agent execution must not begin.
 *
 * Shutdown is deterministic and idempotent: relays are closed and their live
 * connections destroyed, only sockets this run created are unlinked, and the
 * directory is removed non-recursively. With `preserveDiagnostics` the
 * directory and a small JSON summary survive for triage, but every socket is
 * still unlinked first — diagnostics never leave an active access path into the
 * guest's capabilities.
 */

import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { logger } from '../logger';
import type { AppleContainerRunSpec } from './run-args';
import type { AppleContainerUpstreamEndpoint } from './transport-capabilities';
import {
  applyAppleContainerTransportToRunSpec,
  planAppleContainerTransport,
  type AppleContainerTransportCapabilityRequest,
  type AppleContainerTransportPlan,
} from './transport-plan';
import {
  AppleContainerCapabilityRelay,
  type AppleContainerRelayDependencies,
  type AppleContainerRelayLimits,
  type AppleContainerRelayStats,
} from './transport-relay';
import {
  createAppleContainerSocketDirectory,
  removeAppleContainerSocketDirectory,
  type AppleContainerSocketDirectoryHandle,
} from './transport-socket-dir';

export interface AppleContainerTransportHealthOptions {
  /** Total connect attempts per upstream, including the first. */
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
}

export const APPLE_CONTAINER_TRANSPORT_DEFAULT_HEALTH: AppleContainerTransportHealthOptions =
  Object.freeze({ attempts: 10, timeoutMs: 2_000, retryDelayMs: 500 });

interface TransportLogger {
  debug(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface AppleContainerTransportDependencies {
  probeUpstream(endpoint: AppleContainerUpstreamEndpoint, timeoutMs: number): Promise<void>;
  createRelay(
    options: ConstructorParameters<typeof AppleContainerCapabilityRelay>[0],
  ): AppleContainerCapabilityRelay;
  sleep(milliseconds: number): Promise<void>;
  logger: TransportLogger;
  relayDependencies?: Partial<AppleContainerRelayDependencies>;
}

export interface AppleContainerTransportStartOptions {
  readonly capabilities: readonly AppleContainerTransportCapabilityRequest[];
  readonly initImage: string;
  readonly baseDirectory?: string;
  readonly runId?: string;
  readonly readOnlyRootfs?: boolean;
  readonly limits?: Partial<AppleContainerRelayLimits>;
  readonly health?: Partial<AppleContainerTransportHealthOptions>;
}

export interface AppleContainerTransportStopOptions {
  /**
   * Keep the run directory and write a `transport-summary.json` describing what
   * ran. Sockets are unlinked either way.
   */
  readonly preserveDiagnostics?: boolean;
}

/** Default TCP reachability probe for an upstream AWF service. */
export async function probeAppleContainerUpstream(
  endpoint: AppleContainerUpstreamEndpoint,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`connect timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    socket.once('connect', () => finish());
    socket.once('error', (error: Error) => finish(error));
  });
}

function defaultDependencies(): AppleContainerTransportDependencies {
  return {
    probeUpstream: probeAppleContainerUpstream,
    createRelay: (options) => new AppleContainerCapabilityRelay(options),
    sleep: (milliseconds) => new Promise((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref?.();
    }),
    logger,
  };
}

/** A started, verified transport. Only produced when every capability works. */
export class AppleContainerTransport {
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(
    readonly plan: AppleContainerTransportPlan,
    readonly directory: AppleContainerSocketDirectoryHandle,
    private readonly relays: readonly AppleContainerCapabilityRelay[],
    private readonly deps: AppleContainerTransportDependencies,
  ) {}

  /** Per-capability counters, safe to log: no payload bytes are retained. */
  stats(): Readonly<Record<string, AppleContainerRelayStats>> {
    const result: Record<string, AppleContainerRelayStats> = {};
    for (const relay of this.relays) {
      result[relay.capability.id] = relay.stats;
    }
    return result;
  }

  /** Merges this transport's plan into a run spec (see {@link applyAppleContainerTransportToRunSpec}). */
  applyTo(spec: AppleContainerRunSpec): AppleContainerRunSpec {
    if (this.stopped) {
      throw new Error('Apple Container transport has been stopped; refusing to build a run spec');
    }
    return applyAppleContainerTransportToRunSpec(spec, this.plan);
  }

  /** Re-runs the end-to-end probe for every capability. */
  async verify(): Promise<void> {
    if (this.stopped) {
      throw new Error('Apple Container transport has been stopped');
    }
    for (const relay of this.relays) {
      await relay.probe();
    }
  }

  /** Deterministic, idempotent teardown. Concurrent calls share one shutdown. */
  async stop(options: AppleContainerTransportStopOptions = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.runStop(options);
    return this.stopping;
  }

  private async runStop(options: AppleContainerTransportStopOptions): Promise<void> {
    const summary = options.preserveDiagnostics ? this.buildSummary() : undefined;
    this.stopped = true;

    const failures: string[] = [];
    for (const relay of this.relays) {
      try {
        await relay.stop();
      } catch (error) {
        failures.push(`${relay.capability.id}: ${describe(error)}`);
      }
    }

      const socketPaths = ownedSocketPaths(this.relays);
    if (summary) {
      // relay.stop() already unlinked these; the sweep is a belt-and-braces
      // guarantee that preserving the directory cannot preserve a live path.
      // A socket that cannot be removed is fatal rather than ignored: leaving
      // it behind would be exactly the access path diagnostics must not keep.
      for (const socketPath of socketPaths) {
        try {
          await fs.unlink(socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(
              `Apple Container transport could not remove ${socketPath} while preserving ` +
              `diagnostics: ${describe(error)}`,
            );
          }
        }
      }
      const summaryPath = path.posix.join(this.directory.path, 'transport-summary.json');
      await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    } else {
      await removeAppleContainerSocketDirectory(this.directory, socketPaths);
    }

    if (failures.length > 0) {
      throw new Error(
        `Apple Container transport shutdown failed for ${failures.length} relay(s): ` +
        failures.join('; '),
      );
    }
  }

  private buildSummary(): Record<string, unknown> {
    return {
      contractVersion: this.plan.contractVersion,
      runId: this.directory.runId,
      initImage: this.plan.initImage,
      guestDirectory: this.plan.guestDirectory,
      capabilities: this.relays.map((relay) => ({
        id: relay.capability.id,
        guestPort: relay.capability.guestPort,
        upstream: `${relay.upstream.host}:${relay.upstream.port}`,
        stats: relay.stats,
      })),
    };
  }
}

/**
 * Starts and verifies the transport.
 *
 * @throws on any unmet precondition or partial startup. Callers must treat a
 * throw as fatal: without a verified transport the agent has no egress and must
 * not be launched.
 */
export async function startAppleContainerTransport(
  options: AppleContainerTransportStartOptions,
  overrides: Partial<AppleContainerTransportDependencies> = {},
): Promise<AppleContainerTransport> {
  const deps: AppleContainerTransportDependencies = { ...defaultDependencies(), ...overrides };
  const health = { ...APPLE_CONTAINER_TRANSPORT_DEFAULT_HEALTH, ...options.health };
  assertHealthOptions(health);

  const directory = await createAppleContainerSocketDirectory({
    baseDirectory: options.baseDirectory ?? os.tmpdir(),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  });

  const started: AppleContainerCapabilityRelay[] = [];
  try {
    const plan = planAppleContainerTransport({
      directory,
      capabilities: options.capabilities,
      initImage: options.initImage,
      ...(options.readOnlyRootfs !== undefined ? { readOnlyRootfs: options.readOnlyRootfs } : {}),
    });

    for (const entry of plan.entries) {
      await waitForUpstream(entry.capability.id, entry.upstream, health, deps);
    }

    for (const entry of plan.entries) {
      const relay = deps.createRelay({
        capability: entry.capability,
        socketPath: entry.hostSocketPath,
        upstream: entry.upstream,
        ...(options.limits ? { limits: options.limits } : {}),
        ...(deps.relayDependencies ? { dependencies: deps.relayDependencies } : {}),
      });
      // Registered for rollback *before* it is started: `start()` binds the
      // listener and then verifies its mode and ownership, so a failure in that
      // tail would otherwise strand a live, still-accepting relay that nothing
      // holds a reference to.
      started.push(relay);
      await relay.start();
    }

    for (const relay of started) {
      await relay.probe();
      deps.logger.debug(
        `Apple Container transport capability ${relay.capability.id} verified ` +
        `(guest 127.0.0.1:${relay.capability.guestPort})`,
      );
    }

    return new AppleContainerTransport(plan, directory, started, deps);
  } catch (error) {
    await rollback(started, directory, deps);
    throw error;
  }
}

async function waitForUpstream(
  capabilityId: string,
  endpoint: AppleContainerUpstreamEndpoint,
  health: AppleContainerTransportHealthOptions,
  deps: AppleContainerTransportDependencies,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= health.attempts; attempt += 1) {
    try {
      await deps.probeUpstream(endpoint, health.timeoutMs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < health.attempts) {
        await deps.sleep(health.retryDelayMs);
      }
    }
  }
  throw new Error(
    `Apple Container transport upstream for capability "${capabilityId}" ` +
    `(${endpoint.host}:${endpoint.port}) never became healthy after ${health.attempts} ` +
    `attempts: ${describe(lastError)}`,
  );
}

/**
 * Undoes a partial startup.
 *
 * Rollback failures are logged rather than thrown so they cannot mask the real
 * cause; the caller always sees the original error.
 */
async function rollback(
  started: readonly AppleContainerCapabilityRelay[],
  directory: AppleContainerSocketDirectoryHandle,
  deps: AppleContainerTransportDependencies,
): Promise<void> {
  for (const relay of started) {
    try {
      await relay.stop();
    } catch (error) {
      deps.logger.warn(
        `Apple Container transport rollback could not stop relay ${relay.capability.id}: ` +
        describe(error),
      );
    }
  }
  try {
    await removeAppleContainerSocketDirectory(directory, ownedSocketPaths(started));
  } catch (error) {
    deps.logger.warn(
      `Apple Container transport rollback could not remove ${directory.path}: ${describe(error)}`,
    );
  }
}

/**
 * Socket paths this run actually bound.
 *
 * A relay that never reached `listen()` does not own its path — it may be the
 * pre-existing file that made `start()` fail — so it is excluded and left
 * untouched.
 */
function ownedSocketPaths(
  relays: readonly AppleContainerCapabilityRelay[],
): readonly string[] {
  return relays.filter((relay) => relay.isBound).map((relay) => relay.socketPath);
}

function assertHealthOptions(health: AppleContainerTransportHealthOptions): void {
  const checks: ReadonlyArray<readonly [keyof AppleContainerTransportHealthOptions, number]> = [
    ['attempts', 1_000],
    ['timeoutMs', 600_000],
    ['retryDelayMs', 600_000],
  ];
  for (const [key, maximum] of checks) {
    const value = health[key];
    const minimum = key === 'retryDelayMs' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `Apple Container transport health ${key} must be an integer in ` +
        `${minimum}..${maximum}; got ${value}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
