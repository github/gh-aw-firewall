import * as fs from 'fs';
import * as path from 'path';
import type { DockerHostContext, DockerHostInvocationStage } from './docker-host-context';
import type { DockerHostContainerOperations } from './docker-host-container';
import { mountDockerHostStorage } from './docker-host-storage';
import { removeDockerHostContainer } from './docker-host-recovery';
import { buildDockerHostStorageProbeArgs } from './docker-host-launch-args';

export async function prepareDockerHostStorage(
  context: DockerHostContext, containers: DockerHostContainerOperations,
  stage: DockerHostInvocationStage, args: string[],
): Promise<void> {
  const { record, entry, signal, debugCheck } = stage;
  try {
    record.mount = await debugCheck('storage-preparation',
      () => mountDockerHostStorage(record.storageTarget, record.storageSource, record.storageBytes));
  } finally {
    record.mountPending = false;
    context.journal.write(record);
  }
  // A local Unix socket does not imply shared mount namespaces (DinD).
  // Probe the *actual* bind's device/inode/capacity from inside the daemon.
  const stat = await debugCheck('storage-preparation', () => {
    fs.writeFileSync(path.join(record.storageTarget, 'seccomp.json'), entry.seccompProfile, { flag: 'wx', mode: 0o400 });
    return fs.statSync(record.storageTarget);
  });
  const probeArgs = buildDockerHostStorageProbeArgs(args, entry.executorKind, record.storageTarget, record.storageBytes, stat);
  const probe = await debugCheck('storage-probe', () => containers.createContainer(record, probeArgs.args, probeArgs.command));
  await debugCheck('storage-probe', async () => {
    if (await containers.runContainer(record, probe, signal) !== 0) throw new Error('Docker daemon cannot see the verified invocation tmpfs');
  });
  await debugCheck('cleanup', () => removeDockerHostContainer(context.docker, record), true);
  delete record.containerId;
  delete record.expected;
  context.journal.write(record);
}
