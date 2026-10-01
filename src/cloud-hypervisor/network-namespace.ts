import { createHash } from 'crypto';
import { LinuxNetworkCommands } from '../microvm/network';
import { assertSafeMicrovmRunId } from '../microvm/network';
import type { MicrovmNetworkResourceObserver } from '../microvm/network';

const NETNS_DIRECTORY = '/var/run/netns';

export interface CloudHypervisorEmptyNetworkNamespacePlan {
  readonly mode: 'none';
  readonly namespaceName: string;
  readonly netnsPath: string;
}

export interface CloudHypervisorNetworkLifecycle {
  setup(): Promise<unknown>;
  cleanup(): Promise<void>;
  captureDiagnostics?(): Promise<string>;
}

export function createCloudHypervisorEmptyNetworkNamespacePlan(
  runId: string,
): CloudHypervisorEmptyNetworkNamespacePlan {
  assertSafeMicrovmRunId(runId);
  const token = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const namespaceName = `awfvm-${token}`;
  return {
    mode: 'none',
    namespaceName,
    netnsPath: `${NETNS_DIRECTORY}/${namespaceName}`,
  };
}

export class CloudHypervisorEmptyNetworkNamespace implements CloudHypervisorNetworkLifecycle {
  private namespaceCreated = false;

  constructor(
    readonly plan: CloudHypervisorEmptyNetworkNamespacePlan,
    private readonly commands: LinuxNetworkCommands,
    private readonly observer?: Pick<MicrovmNetworkResourceObserver, 'resourceCreated'>,
  ) {}

  async setup(): Promise<void> {
    if (this.namespaceCreated) return;
    try {
      await this.commands.ip(['netns', 'add', this.plan.namespaceName]);
      this.namespaceCreated = true;
      await this.observer?.resourceCreated('netns');
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new Error(
          `Cloud Hypervisor empty network namespace setup failed: ${formatError(error)}; ` +
          `rollback also failed: ${formatError(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  async captureDiagnostics(): Promise<string> {
    if (!this.namespaceCreated) return '';
    return this.commands.captureDiagnosticsInNamespace(this.plan.namespaceName);
  }

  async cleanup(): Promise<void> {
    if (!this.namespaceCreated) return;
    await this.commands.ip(['netns', 'delete', this.plan.namespaceName]);
    this.namespaceCreated = false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
