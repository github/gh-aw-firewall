import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { CloudHypervisorEnclaveHostServiceOptions } from '../enclave/cloud-hypervisor-host-service';
import {
  HostExecutorResourceJournal, hostExecutorStorageDirectory, hostExecutorVmRunId,
} from '../enclave/host-executor-journal';
import { HOST_EXECUTOR_ENTRY_ID_PATTERN, HOST_EXECUTOR_ID_PATTERN } from '../enclave/host-executor-protocol';
import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import { assertTrustedAncestorChain, assertTrustedHostTool, resolveTrustedHostTool } from './artifact-trust';
import {
  HostPreflightReporter, hostPreflightReason, markHostPreflightError, type HostPreflightScope,
} from './host-preflight-progress';
import { preflightCloudHypervisorEnclaveArtifacts } from './enclave-artifact-preflight';
import type { CloudHypervisorEnclaveArtifactPreflightOptions } from './enclave-executor-types';
import { copySparseFileWithRsync, runCloudHypervisorPreflight, type CloudHypervisorHostToolPaths } from './preflight';
import { prepareTrustedInvocationStorage } from './trusted-enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';

async function trustedDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw markHostPreflightError(new Error('Preflight storage requires a normalized absolute directory'), 'path-not-absolute');
  }
  await assertTrustedAncestorChain('preflight storage', path.join(directory, 'child'), {
    uid: 0, access: fs.access, lstat: fs.lstat, sha256: async () => '',
  });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 || await fs.realpath(directory) !== directory) {
    throw markHostPreflightError(new Error('Preflight storage requires root-owned trusted directories'),
      stat.isSymbolicLink() ? 'file-symlink' : !stat.isDirectory() ? 'file-type' :
        stat.uid !== 0 ? 'file-owner' : (stat.mode & 0o022) !== 0 ? 'file-writable' : 'requirement-not-met');
  }
}

async function prepareInvocationRoot(directory: string): Promise<void> {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw markHostPreflightError(new Error('Preflight storage requires a normalized absolute directory'), 'path-not-absolute');
  }
  let current = path.parse(directory).root;
  await trustedDirectory(current);
  for (const component of directory.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await trustedDirectory(current);
  }
}

async function trustedTool(tool: 'mount' | 'umount' | 'rsync', environment: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await resolveTrustedHostTool(tool, environment, assertTrustedHostTool);
  } catch (error) {
    throw markHostPreflightError(new Error(`Bounded enclave preflight requires trusted host tool "${tool}"`),
      hostPreflightReason(error));
  }
}

async function storageTools(
  environment: NodeJS.ProcessEnv,
  report: HostPreflightReporter,
): Promise<Pick<CloudHypervisorHostToolPaths, 'mount' | 'umount'>> {
  return {
    mount: await report.check('tool-mount', () => trustedTool('mount', environment)),
    umount: await report.check('tool-umount', () => trustedTool('umount', environment)),
  };
}

/** Internal preflight uses the same role-sized, journaled domain as execution. */
export function createBoundedEnclavePreflight(
  options: CloudHypervisorEnclaveHostServiceOptions,
  active: Set<string>,
): {
  preflight(config: CloudHypervisorOptions): ReturnType<typeof runCloudHypervisorPreflight>;
  preflightEnclaveArtifacts(
    artifactOptions: CloudHypervisorEnclaveArtifactPreflightOptions,
  ): ReturnType<typeof preflightCloudHypervisorEnclaveArtifacts>;
} {
  const withStorage = async <T>(
    operation: (allocation: Awaited<ReturnType<typeof prepareTrustedInvocationStorage>>,
      journal: HostExecutorResourceJournal, report: HostPreflightReporter) => Promise<T>,
    scope: HostPreflightScope = 'bounded-runtime',
  ): Promise<T> => {
    const run = options.runState;
    const report = new HostPreflightReporter(scope, options.onHostPreflight);
    const entries = run.entries.filter((entry) => entry.executorKind === 'script' || entry.executorKind === 'agent');
    const entry = entries.sort((left, right) =>
      CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[left.executorKind].writableStorageBytes -
      CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[right.executorKind].writableStorageBytes)[0];
    await report.check('configured-role', () => {
      if (!entry || !HOST_EXECUTOR_ENTRY_ID_PATTERN.test(entry.entryId) ||
        !HOST_EXECUTOR_ID_PATTERN.test(run.runId)) {
        throw markHostPreflightError(new Error('Bounded enclave preflight requires a configured static role'), 'requirement-not-met');
      }
    });
    const tools = await storageTools(options.environment ?? process.env, report);
    await report.check('invocation-root', () => prepareInvocationRoot(run.invocationsDir));
    const parent = path.join(run.invocationsDir, entry.entryId);
    await report.check('invocation-parent', async () => {
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await trustedDirectory(parent);
    });
    const invocationId = randomBytes(16).toString('hex');
    const plan: HostExecutorInvocationPlan = {
      runId: run.runId, entryId: entry.entryId, invocationId, executorKind: entry.executorKind,
      timeoutMs: entry.timeoutMs, requestHash: '0'.repeat(64), admissionId: invocationId,
      schemaHash: '0'.repeat(64), schema: { type: 'const', value: null }, payload: '',
      invocationHostDir: path.join(parent, invocationId),
    };
    const root = hostExecutorStorageDirectory(hostExecutorVmRunId(plan));
    active.add(root);
    let journal: HostExecutorResourceJournal | undefined;
    let allocation: Awaited<ReturnType<typeof prepareTrustedInvocationStorage>> | undefined;
    let directoryCaptured = false;
    try {
      journal = await report.check('resource-journal', () =>
        HostExecutorResourceJournal.create(run, plan, hostExecutorVmRunId(plan)));
      const capturedJournal = journal;
      allocation = await report.check('storage-allocation', () =>
        prepareTrustedInvocationStorage(run, plan, capturedJournal, tools, report));
      await report.check('invocation-directory', async () => {
        await fs.mkdir(plan.invocationHostDir, { mode: 0o700 });
        await capturedJournal.captureDirectory();
      });
      directoryCaptured = true;
      const profile = CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES[entry.executorKind];
      const capturedAllocation = allocation;
      await report.check('invocation-mount', async () => {
        await capturedAllocation.dependencies.mountTmpfs!(
          plan.invocationHostDir, profile.writableStorageBytes, profile.uid, profile.gid, tools,
        );
        await capturedJournal.captureMount();
      });
      await report.check('storage-verification', () =>
        capturedAllocation.dependencies.verifyStorage!(plan.invocationHostDir, profile.writableStorageBytes));
      return await operation(allocation, journal, report);
    } finally {
      if (journal) {
        // A failed copy may have removed its partial snapshot already. Reclaim
        // the identity-known enclosing domain, not an assumed snapshot path.
        if (allocation) await allocation.close();
        else await journal.closeStorage(tools.umount);
        if (directoryCaptured) {
          await journal.verifyDirectory();
          await fs.rm(plan.invocationHostDir, { recursive: true, force: true });
        }
        await journal.complete();
        active.delete(root);
      }
    }
  };
  return {
    preflight: async (config) => {
      const verified = await withStorage(async (allocation, journal, report) =>
        runCloudHypervisorPreflight(config, {
          hostPreflightReporter: report,
          createArtifactSnapshot: async (sources, copy) => {
            await journal.prepareSnapshot();
            return allocation.dependencies.createArtifactSnapshot!(
              sources, copy, (directory) => journal.captureSnapshot(directory),
            );
          },
          // The whole sealed domain is closed in withStorage's finally block.
          removeArtifactSnapshot: async () => undefined,
        }));
      return {
        ...verified,
        cloudHypervisorBinary: config.cloudHypervisorBinary,
        virtiofsdBinary: path.join(path.dirname(config.cloudHypervisorBinary), 'virtiofsd'),
        kernelPath: config.kernelPath!,
        rootfsPath: config.rootfsPath!,
        supervisorPath: config.supervisorPath!,
        artifactSnapshotDirectory: path.dirname(config.cloudHypervisorBinary),
      };
    },
    preflightEnclaveArtifacts: (artifactOptions) => withStorage(async (allocation, _journal, report) => {
      const rsync = await report.check('tool-rsync', () => trustedTool('rsync', options.environment ?? process.env));
      const verificationRoot = path.join(allocation.workDir, 'verification');
      await report.check('verification-directory', () => fs.mkdir(verificationRoot, { mode: 0o700 }));
      return report.check('enclave-artifacts', () =>
        preflightCloudHypervisorEnclaveArtifacts(artifactOptions, verificationRoot,
          (source, destination) => copySparseFileWithRsync(rsync, source, destination)));
    }, 'bounded-artifacts'),
  };
}
