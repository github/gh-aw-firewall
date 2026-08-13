import { LinuxNetworkCommands } from './network-commands';
import {
  generateMicrovmNftRuleset,
  microvmCidrPrefixLength,
} from './network-plan';
import type {
  MicrovmConnectivityProbe,
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
} from './network-types';

export class MicrovmNetworkManager implements MicrovmNetworkLifecycle {
  private setupComplete = false;
  private namespaceCreated = false;
  private hostVethCreated = false;
  private dockerUserRuleInserted = false;

  constructor(
    readonly plan: MicrovmNetworkPlan,
    private readonly commands = new LinuxNetworkCommands(),
    private readonly probe?: MicrovmConnectivityProbe,
  ) {}

  async setup(): Promise<MicrovmNetworkPlan> {
    if (this.setupComplete) return this.plan;
    const infrastructurePrefixLength = microvmCidrPrefixLength(
      this.plan.infrastructureCidr,
      'infrastructure CIDR',
    );

    try {
      await this.commands.ip(['netns', 'add', this.plan.namespaceName]);
      this.namespaceCreated = true;
      await this.commands.ip([
        'link', 'add', this.plan.hostVethName,
        'type', 'veth',
        'peer', 'name', this.plan.namespaceVethName,
      ]);
      this.hostVethCreated = true;
      await this.commands.ip([
        'link', 'set', this.plan.namespaceVethName,
        'netns', this.plan.namespaceName,
      ]);
      await this.commands.ip([
        'link', 'set', this.plan.hostVethName,
        'master', this.plan.infrastructureBridge,
      ]);
      await this.commands.ip(['link', 'set', this.plan.hostVethName, 'up']);
      // See LinuxNetworkCommands.ensureBridgeForwardAcceptRule's own doc
      // comment: Docker's own "same bridge" forwarding accept rule does
      // not reliably match traffic from this manually-injected veth in
      // this environment, silently dropping it via the FORWARD chain's
      // default-drop policy. Must happen before any guest traffic can
      // possibly flow (i.e. before the tap/guest side is even brought
      // up below).
      await this.commands.ensureBridgeForwardAcceptRule(this.plan.infrastructureBridge);
      this.dockerUserRuleInserted = true;

      await this.commands.ipInNamespace(this.plan.namespaceName, [
        'tuntap', 'add',
        'dev', this.plan.tapName,
        'mode', 'tap',
        'user', String(this.plan.tapOwnerUid),
        'group', String(this.plan.tapOwnerGid),
        ...(this.plan.tapVnetHdr ? ['vnet_hdr'] : []),
      ]);
      await this.commands.ipInNamespace(this.plan.namespaceName, [
        'addr', 'add',
        `${this.plan.guestGatewayIp}/${this.plan.guestPrefixLength}`,
        'dev', this.plan.tapName,
      ]);
      await this.commands.ipInNamespace(
        this.plan.namespaceName,
        ['link', 'set', this.plan.tapName, 'up'],
      );
      await this.commands.ipInNamespace(this.plan.namespaceName, [
        'addr', 'add',
        `${this.plan.infrastructureIp}/${infrastructurePrefixLength}`,
        'dev', this.plan.namespaceVethName,
      ]);
      await this.commands.ipInNamespace(
        this.plan.namespaceName,
        ['link', 'set', this.plan.namespaceVethName, 'up'],
      );
      await this.commands.ipInNamespace(
        this.plan.namespaceName,
        ['link', 'set', 'lo', 'up'],
      );
      await this.commands.sysctlInNamespace(
        this.plan.namespaceName,
        'net.ipv4.ip_forward=1',
      );
      await this.commands.sysctlInNamespace(
        this.plan.namespaceName,
        'net.ipv6.conf.all.disable_ipv6=1',
      );
      await this.commands.sysctlInNamespace(
        this.plan.namespaceName,
        'net.ipv6.conf.default.disable_ipv6=1',
      );
      await this.commands.nftInNamespace(
        this.plan.namespaceName,
        ['-f', '-'],
        generateMicrovmNftRuleset(this.plan),
      );
      await this.probe?.verify(this.plan);
      this.setupComplete = true;
      return this.plan;
    } catch (error) {
      try {
        await this.cleanup();
      } catch (cleanupError) {
        throw new Error(
          `microVM network setup failed: ${formatError(error)}; ` +
          `rollback also failed: ${formatError(cleanupError)}`,
        );
      }
      throw error;
    }
  }

  async captureDiagnostics(): Promise<string> {
    if (!this.setupComplete) return '';
    const [namespaceDiagnostics, hostBridgeDiagnostics] = await Promise.all([
      this.commands.captureDiagnosticsInNamespace(this.plan.namespaceName),
      this.commands.captureHostBridgeDiagnostics(this.plan.infrastructureBridge),
    ]);
    return [namespaceDiagnostics, hostBridgeDiagnostics].join('\n');
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    if (this.dockerUserRuleInserted) {
      await attempt(async () => {
        await this.commands.removeBridgeForwardAcceptRule(this.plan.infrastructureBridge);
        this.dockerUserRuleInserted = false;
      });
    }
    if (this.hostVethCreated) {
      await attempt(async () => {
        await this.commands.ip(['link', 'delete', this.plan.hostVethName]);
        this.hostVethCreated = false;
      });
    }
    if (this.namespaceCreated && !this.hostVethCreated) {
      await attempt(async () => {
        await this.commands.ip(['netns', 'delete', this.plan.namespaceName]);
        this.namespaceCreated = false;
      });
    }
    this.setupComplete = false;

    if (errors.length > 0) {
      throw new Error(
        `Failed to clean up microVM network: ${errors.map(formatError).join('; ')}`,
      );
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
