import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { parseImageTag } from '../image-tag';
import { resolveRuntimeImage } from '../image-resolver';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import { deriveDockerEnclaveRunnerConfig } from '../services/enclave-mcp-service';
import {
  createDockerHostEnclaveExecutor, type DockerHostAgentAuthority, type DockerHostAuthoritySettlement,
  type DockerHostExecutorEntry,
} from './docker-host-executor';
import { dockerMemoryBytes, dockerWritableBudget } from './docker-host-storage';
import { getEnclaveHostDynamicAuthority } from './dynamic-delegation';
import type { DynamicDelegationService } from './dynamic-delegation-service';
import {
  HOST_EXECUTOR_SOCKET_NAME,
  type HostEnclaveExecutorBackend, type HostExecutorBackendResult, type HostExecutorInvocationPlan,
} from './host-executor-server';
import { HostExecutorLifecycleRegistry } from './host-executor-lifecycle';
import { isValidHostExecutorResult } from './host-executor-protocol';
import { deriveHostExecutorRunState } from './host-executor-run-state';
import { startHostExecutorService } from './host-service';
import { deriveEnclaveSeedId, readEnclaveRunId, resolveEnclavePaths } from './paths';
import { updateEnclaveStartupProgress } from './startup-progress';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const enclaveSeccompProfile = require('../../containers/enclave/seccomp.json');

export function isDockerEnclaveSelected(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && Object.values(config.enclaves.executors)
      .some((entry) => entry.enabled && entry.runtime === 'docker');
}

const lifecycle = new HostExecutorLifecycleRegistry<WrapperConfig, never>('Docker enclave');

export function assertDockerEnclaveHostPrerequisites(
  config: WrapperConfig,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!isDockerEnclaveSelected(config)) return;
  const dockerHost = config.awfDockerHost ?? environment.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
  if (!dockerHost.startsWith('unix://')) {
    throw new Error('Docker host enclaves require a local Unix-socket Docker host');
  }
  if (config.dockerHostPathPrefix && config.dockerHostPathPrefix !== '/') {
    throw new Error('Docker host enclaves do not support dockerHostPathPrefix or split-filesystem daemons; mount policy is never bypassed');
  }
  let capabilities = '';
  try {
    capabilities = /^CapEff:\s*([0-9a-f]+)$/mi.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1] || '';
  } catch {
    // Report the same actionable prerequisite failure when host capability state is unavailable.
  }
  if (!capabilities || (BigInt(`0x${capabilities}`) & (1n << 21n)) === 0n) {
    throw new Error('Docker host enclaves require effective CAP_SYS_ADMIN to mount and clean bounded tmpfs storage');
  }
}

export async function startDockerEnclaveLifecycle(
  config: WrapperConfig,
  environment: NodeJS.ProcessEnv = process.env,
  onLifecycleStart?: () => void,
): Promise<void> {
  if (!isDockerEnclaveSelected(config)) return;
  assertDockerEnclaveHostPrerequisites(config, environment);
  const dockerHost = config.awfDockerHost ?? environment.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
  const paths = resolveEnclavePaths(config.workDir);
  const runState = deriveHostExecutorRunState(config, paths, 'Docker enclave', { dynamicAgents: true });
  const registry = config.imageRegistry || 'ghcr.io/github/gh-aw-firewall';
  const parsedTag = parseImageTag(config.imageTag || 'latest');
  const imageConfig = {
    useGHCR: !config.buildLocal,
    registry,
    parsedTag,
    projectRoot: path.join(__dirname, '..', '..'),
    resolveImage: (name: import('../image-resolver').RuntimeImageName) =>
      resolveRuntimeImage(config, name, registry, parsedTag),
  };
  const entries: DockerHostExecutorEntry[] = Object.entries(config.enclaves!.executors)
    .filter(([, entry]) => entry.enabled)
    .map(([kind, entry]) => {
      const executorKind = kind as 'script' | 'agent';
      const runner = deriveDockerEnclaveRunnerConfig(config, imageConfig, executorKind);
      const hostWritableBytes = dockerMemoryBytes(entry.tmpfsLimit);
      const { containerBytes } = dockerWritableBudget(
        executorKind, entry.tmpfsLimit, hostWritableBytes, Number.MAX_SAFE_INTEGER,
      );
      return {
        entryId: kind, executorKind, config: runner,
        hostWritableBytes, aggregateWritableBytes: hostWritableBytes + containerBytes,
      };
    });
  await lifecycle.start(paths.root, config, runState.runId, async (run) => {
    onLifecycleStart?.();
    updateEnclaveStartupProgress(config, { stage: 'host-service' });
    let listenerExists = false;
    try {
      fs.lstatSync(path.join(paths.hostExecutorDir, HOST_EXECUTOR_SOCKET_NAME));
      listenerExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (listenerExists) {
      throw new Error('Docker enclave host listener already exists; recovery is not authorized');
    }
    const seccompFd = fs.openSync(path.join(paths.root, 'docker-enclave-seccomp.json'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);
    try {
      fs.writeFileSync(seccompFd, `${JSON.stringify(enclaveSeccompProfile)}\n`);
      fs.fsyncSync(seccompFd);
    } finally { fs.closeSync(seccompFd); }
    run.server = await startHostExecutorService({
      runtimeDir: paths.hostExecutorDir,
      runState,
      createBackend: async () => {
        const authorities = new Map<string, {
          service: DynamicDelegationService; started?: number; binding?: DockerHostAgentAuthority;
          settlement?: Promise<{ revoked: boolean }>;
        }>();
        let settlementFailed = false;
        const settleAuthority = (
          plan: HostExecutorInvocationPlan,
          usage: DockerHostAuthoritySettlement,
        ): Promise<{ revoked: boolean }> => {
          const authority = authorities.get(plan.invocationId);
          if (!authority) return Promise.resolve({ revoked: true });
          authority.settlement ??= Promise.resolve().then(async () => {
            const limits = config.enclaves!.executors.agent.dynamic!.limits;
            const uncertain = usage.uncertain || !usage.cleanupComplete;
            const receipt = await authority.service.settle({
              version: 1, invocationId: plan.invocationId,
              outcome: usage.outcome === 'executor-failure' ? 'agent-failure' : usage.outcome,
              outputBytes: uncertain ? limits.maxOutputBytes : usage.outputBytes,
              executionSeconds: uncertain ? limits.timeoutSeconds : usage.executionSeconds,
            });
            if (!receipt.revoked) settlementFailed = true;
            return { revoked: receipt.revoked };
          }).catch((error) => {
            settlementFailed = true;
            throw error;
          });
          return authority.settlement;
        };
        let githubAgentId: string | undefined;
        const staticRepositories = new Map(config.enclaves!.privateRepos.map(({ repo }) => {
          const repository = normalizePrivateRepositoryKey(repo);
          return [deriveEnclaveSeedId(runState.runId, repository), repository];
        }));
        if (entries.some((entry) => entry.executorKind === 'agent' && entry.config.githubEnabled)) {
          const fd = fs.openSync(paths.githubAgentIdPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
              || (stat.mode & 0o777) !== 0o600 || stat.size > 129) {
              throw new Error('Docker enclave GitHub identity requires a trusted private custody file');
            }
            githubAgentId = fs.readFileSync(fd, 'utf8').trim();
            if (!/^[A-Za-z0-9_-]{32,128}$/.test(githubAgentId)) {
              throw new Error('Docker enclave GitHub identity is invalid');
            }
          } finally { fs.closeSync(fd); }
        }
        const backend = createDockerHostEnclaveExecutor({
          runId: runState.runId,
          journalDir: path.join(paths.hostExecutorJournalDir, 'docker'),
          entries,
          dockerSocketPath: dockerHost.slice('unix://'.length),
          resolveAgentAuthority: async (plan, signal) => {
            if (signal.aborted) throw new Error('Docker enclave admission cancelled');
            if (plan.selector !== undefined) {
              const binding = authorities.get(plan.invocationId)?.binding;
              if (!binding) throw new Error('Dynamic enclave admission denied');
              return binding;
            }
            if (!githubAgentId) return {};
            const repository = plan.seedId && staticRepositories.get(plan.seedId);
            if (!repository) throw new Error('Static Docker enclave repository is not in the trusted seed catalog');
            return { githubAgentId, repository };
          },
          settleAgentAuthority: settleAuthority,
        });
        await backend.prepare();
        const wrapped: HostEnclaveExecutorBackend = {
          async execute(plan, signal) {
            let result: HostExecutorBackendResult = { outcome: 'executor-failure' };
            let executionStarted = false;
            try {
              if (signal.aborted) return { outcome: 'cancelled' };
              if (plan.selector !== undefined) {
                const service = getEnclaveHostDynamicAuthority(config);
                // Retain settlement responsibility even if admission throws after
                // minting an identity (for example, a durable audit write fails).
                authorities.set(plan.invocationId, { service });
                const admission = await service.admit({
                  version: 1, invocationId: plan.invocationId,
                  selector: plan.selector, schemaHash: plan.schemaHash,
                });
                if (admission.admitted) {
                  authorities.get(plan.invocationId)!.binding = {
                    repository: admission.repository, githubBearer: admission.executorBearer,
                    readMode: admission.readMode,
                  };
                } else if (service.isAdmitting) {
                  result = { outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: true };
                } else {
                  settlementFailed = true;
                  result = { outcome: 'executor-failure', cleanupComplete: false };
                }
              }
              if (plan.selector === undefined || authorities.get(plan.invocationId)?.binding) {
                if (signal.aborted) result = { outcome: 'cancelled' };
                else {
                  executionStarted = true;
                  const authority = authorities.get(plan.invocationId);
                  if (authority) authority.started = Date.now();
                  const execution = await backend.execute(plan, signal);
                  result = execution && isValidHostExecutorResult(execution.outcome, execution.result)
                    ? execution : { outcome: 'executor-failure', cleanupComplete: false };
                }
              }
            } catch {
              result = {
                outcome: signal.aborted ? 'cancelled' : 'executor-failure',
                ...(executionStarted ? { cleanupComplete: false } : {}),
              };
            }
            const authority = authorities.get(plan.invocationId);
            if (authority) {
              try {
                const uncertainCleanup = result.cleanupComplete === false;
                const receipt = await settleAuthority(plan, {
                  outcome: result.outcome, uncertain: uncertainCleanup,
                  cleanupComplete: !uncertainCleanup,
                  outputBytes: result.result === undefined ? 0 : Buffer.byteLength(result.result),
                  executionSeconds: authority.started === undefined ? 0
                    : Math.max(0, Math.ceil((Date.now() - authority.started) / 1000)),
                });
                if (!receipt.revoked) throw new Error('Dynamic enclave identity revocation is unresolved');
              } catch {
                settlementFailed = true;
                return { outcome: 'executor-failure', cleanupComplete: false };
              } finally {
                authorities.delete(plan.invocationId);
              }
            }
            return result;
          },
          async close() {
            await backend.close?.();
            if (settlementFailed) throw new Error('Dynamic Docker enclave settlement requires trusted recovery');
          },
        };
        return wrapped;
      },
      startupFailureMessage: 'Docker enclave host service could not start',
    });
  });
}

export function closeDockerEnclaveAdmissions(config: WrapperConfig): void {
  lifecycle.closeAdmissions(resolveEnclavePaths(config.workDir).root, config);
}

export function assertDockerEnclaveLifecycleReady(config: WrapperConfig): Promise<void> {
  return lifecycle.ready(resolveEnclavePaths(config.workDir).root, config);
}

export async function stopDockerEnclaveLifecycle(
  config: WrapperConfig,
  allowNeverLaunchedStaging: () => boolean = () => false,
): Promise<void> {
  const paths = resolveEnclavePaths(config.workDir);
  if (!lifecycle.has(paths.root) && !isDockerEnclaveSelected(config)) return;
  await lifecycle.stop(paths.root, config, () => {
    if (allowNeverLaunchedStaging()) return;
    const runId = readEnclaveRunId(paths);
    if (runId && lifecycle.completed(paths.root, runId)) return;
    // No in-memory ownership means neither labels nor the absence of a journal
    // proves that a legacy or interrupted invocation has released its mounts.
    if (runId) {
      throw new Error('Docker enclave recovery requires trusted reconciliation before cleanup');
    }
    if (!runId && fs.existsSync(paths.root)) {
      throw new Error('Docker enclave run identity is missing; private recovery state is preserved');
    }
  }, async (run) => {
    await run.server?.close();
    const recoveryDirectory = path.join(paths.hostExecutorJournalDir, 'docker');
    if (fs.existsSync(recoveryDirectory)) {
      const stat = fs.lstatSync(recoveryDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
        throw new Error('Docker enclave recovery directory is unsafe; private recovery state is preserved');
      }
      if (fs.readdirSync(recoveryDirectory).some((file) => file.startsWith(`${run.runId}-`))) {
        throw new Error('Docker enclave resource cleanup is pending; private recovery state is preserved');
      }
    }
    if (run.failed) throw new Error('Docker enclave startup failed; private recovery state is preserved');
  });
}
