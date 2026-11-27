import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { deriveDockerEnclaveEntries } from './docker-enclave-entries';
import { createDockerHostAuthority } from './docker-host-authority';
import { wrapDockerHostExecution } from './docker-host-execution';
import { createDockerHostEnclaveExecutor } from './docker-host-executor';
import { dockerMemoryBytes } from './docker-host-storage';
import {
  assertDockerStorageHelperAvailable, DOCKER_ENCLAVE_HELPER_ROOT, DOCKER_ENCLAVE_MAX_HOST_BYTES,
  hasDockerHostMountCapability, dockerHelperHostStateRoot,
} from './docker-storage-helper';
import { assertPrivateRootIsolated, resolvePathThroughExistingAncestor } from './mount-policy';
import { HOST_EXECUTOR_SOCKET_NAME } from './host-executor-server';
import { HostExecutorLifecycleRegistry } from './host-executor-lifecycle';
import { deriveHostExecutorRunState } from './host-executor-run-state';
import { startHostExecutorService } from './host-service';
import { readEnclaveRunId, resolveEnclavePaths } from './paths';
import { updateEnclaveStartupProgress } from './startup-progress';
import {
  resolvePublicEnclaveDebugConfig, publicEnclaveDebugEnabled, verifyPublicEnclaveDebugRepositories,
  PublicDebugVisibilityError, resolveDockerPublicEnclaveDebugPaths,
} from './public-debug';
import { logger } from '../logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const enclaveSeccompProfile = require('../../containers/enclave/seccomp.json');

export function isDockerEnclaveSelected(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && Object.values(config.enclaves.executors)
      .some((entry) => entry.enabled && entry.runtime === 'docker');
}

const lifecycle = new HostExecutorLifecycleRegistry<WrapperConfig, never>('Docker enclave');

export function resolveDockerEnclavePaths(workDir: string): ReturnType<typeof resolveEnclavePaths> {
  const paths = resolveEnclavePaths(workDir);
  if (!hasDockerHostMountCapability()) {
    paths.hostExecutorJournalDir = path.join(dockerHelperHostStateRoot(), 'host-executor-journal');
  }
  return paths;
}

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
  if (!hasDockerHostMountCapability()) {
    if (Object.values(config.enclaves!.executors).some((entry) => entry.enabled
      && dockerMemoryBytes(entry.tmpfsLimit) > DOCKER_ENCLAVE_MAX_HOST_BYTES)) {
      throw new Error('Docker enclave helper host tmpfs exceeds the 4 GiB hard ceiling');
    }
    const paths = resolveDockerEnclavePaths(config.workDir);
    assertPrivateRootIsolated(config, { root: DOCKER_ENCLAVE_HELPER_ROOT }, environment, process.cwd(), 'Docker helper storage');
    const storage = resolvePathThroughExistingAncestor(DOCKER_ENCLAVE_HELPER_ROOT);
    // Include every broker bind, not only those also visible to the primary.
    for (const brokerPath of [paths.seedsDir, paths.workDir, paths.controlDir, paths.auditDir,
      paths.runDir, paths.delegationChannelDir, paths.hostExecutorDir]) {
      const broker = resolvePathThroughExistingAncestor(brokerPath);
      if (storage === broker || storage.startsWith(`${broker}/`) || broker.startsWith(`${storage}/`)) {
        throw new Error('Docker helper storage must not overlap broker bind mounts');
      }
    }
    assertDockerStorageHelperAvailable();
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
  const paths = resolveDockerEnclavePaths(config.workDir);
  const runState = deriveHostExecutorRunState(config, paths, 'Docker enclave', { dynamicAgents: true });
  const entries = deriveDockerEnclaveEntries(config);
  await lifecycle.start(paths.root, config, runState.runId, async (run) => {
    onLifecycleStart?.();
    const debugConfig = resolvePublicEnclaveDebugConfig(config);
    let publicDebug = publicEnclaveDebugEnabled(debugConfig);
    if (publicDebug) {
      try {
        await verifyPublicEnclaveDebugRepositories(debugConfig);
        run.publicDebugVerified = true;
        const { protectedRoot } = resolveDockerPublicEnclaveDebugPaths();
        assertPrivateRootIsolated(config, { root: protectedRoot }, environment, process.cwd(), 'Public enclave diagnostics');
      } catch (error) {
        if (!(error instanceof PublicDebugVisibilityError)) throw error;
        publicDebug = false;
        logger.warn(`Public enclave debug capture disabled: ${error.message}`);
      }
    }
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
        const authority = createDockerHostAuthority(config, paths, runState.runId, entries);
        const backend = createDockerHostEnclaveExecutor({
          runId: runState.runId,
          journalDir: path.join(paths.hostExecutorJournalDir, 'docker'),
          entries,
          dockerSocketPath: dockerHost.slice('unix://'.length),
          publicDebug,
          resolveAgentAuthority: authority.resolveAgentAuthority,
          settleAgentAuthority: authority.settleAuthority,
        });
        await backend.prepare();
        return wrapDockerHostExecution(config, backend, authority);
      },
      startupFailureMessage: 'Docker enclave host service could not start',
    });
  });
}

export function closeDockerEnclaveAdmissions(config: WrapperConfig): void {
  lifecycle.closeAdmissions(resolveDockerEnclavePaths(config.workDir).root, config);
}

export function assertDockerEnclaveLifecycleReady(config: WrapperConfig): Promise<void> {
  return lifecycle.ready(resolveDockerEnclavePaths(config.workDir).root, config);
}

export async function stopDockerEnclaveLifecycle(
  config: WrapperConfig,
  allowNeverLaunchedStaging: () => boolean = () => false,
): Promise<void> {
  const paths = resolveDockerEnclavePaths(config.workDir);
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
