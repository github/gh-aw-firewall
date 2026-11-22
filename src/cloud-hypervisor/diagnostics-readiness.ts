import type { ExecaChildProcess } from 'execa';
import type {
  CloudHypervisorManagerDependencies,
  CloudHypervisorRunPaths,
} from './manager-types';

export async function waitForApiSocket(
  dependencies: CloudHypervisorManagerDependencies,
  paths: CloudHypervisorRunPaths,
  apiTimeoutMs: number,
  child: ExecaChildProcess<string> | undefined,
): Promise<void> {
  const deadline = Date.now() + apiTimeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode != null || child.signalCode != null)) {
      throw new Error(
        `Cloud Hypervisor exited before API readiness with code ${child.exitCode ?? 'null'} ` +
        `and signal ${child.signalCode ?? 'null'}`,
      );
    }
    try {
      await dependencies.access(paths.apiSocketPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    await dependencies.sleep(25);
  }
  throw new Error(
    `Cloud Hypervisor API socket was not ready after ${apiTimeoutMs}ms: ` +
    paths.apiSocketPath,
  );
}
