export interface MicrovmNetworkHostTools {
  readonly ip: string;
  readonly nft: string;
  readonly sysctl: string;
}

/**
 * Generic tap-device descriptor a VMM's network-interface configuration API
 * needs. Field names intentionally match the wire shape already used by
 * Firecracker's `PUT /network-interfaces`; a future backend with a
 * differently-shaped API translates from this structural descriptor.
 */
export interface MicrovmTapInterface {
  readonly iface_id: string;
  readonly host_dev_name: string;
  readonly guest_mac?: string;
}

export interface MicrovmAllowedEndpoint {
  readonly name: string;
  readonly ip: string;
  readonly port: number;
}

export interface MicrovmControlPeer {
  readonly ip: string;
  readonly ports: readonly number[];
}

export interface MicrovmNetworkPlanOptions {
  readonly infrastructureBridge: string;
  readonly enableApiProxy: boolean;
  readonly tapOwnerUid: number;
  readonly tapOwnerGid: number;
  readonly controlPeer?: MicrovmControlPeer;
  readonly controlPeers?: readonly MicrovmControlPeer[];
  /**
   * Create the TAP device with the `vnet_hdr` feature (a `struct
   * virtio_net_hdr` prefix on every frame read from/written to the tap
   * fd). Cloud Hypervisor's own tap handling (`Tap::open_named()` in
   * `net_util/src/tap.rs`) always re-opens the tap with `IFF_VNET_HDR`
   * requested; if the tap wasn't *created* with that feature available,
   * the host kernel and Cloud Hypervisor disagree on frame layout for
   * one direction, and host-to-guest traffic silently fails to reach the
   * guest even though guest-to-host traffic (and the host-side veth/nft
   * layer) keeps working normally -- exactly the asymmetric RX-works/
   * TX-stalls pattern observed live (tap RX=10 packets, TX=1 packet,
   * despite 23 response packets already having arrived on the veth).
   * Firecracker's own tap handling does not request `IFF_VNET_HDR`, so
   * this defaults to `false` (this shared code's prior, Firecracker-only
   * behavior) and Cloud Hypervisor opts in explicitly.
   */
  readonly tapVnetHdr?: boolean;
}

export interface MicrovmNetworkPlan {
  readonly runId: string;
  readonly namespaceName: string;
  readonly netnsPath: string;
  readonly nftTableName: string;
  readonly infrastructureBridge: string;
  readonly hostVethName: string;
  readonly namespaceVethName: string;
  readonly tapName: string;
  readonly infrastructureIp: string;
  readonly infrastructureCidr: string;
  readonly hostGatewayIp: string;
  readonly guestSubnet: string;
  readonly guestIp: string;
  readonly guestGatewayIp: string;
  readonly guestPrefixLength: number;
  readonly guestMac: string;
  readonly tapOwnerUid: number;
  readonly tapOwnerGid: number;
  readonly tapVnetHdr: boolean;
  readonly allowedEndpoints: readonly MicrovmAllowedEndpoint[];
  readonly networkInterface: MicrovmTapInterface;
}

export interface MicrovmConnectivityProbe {
  verify(plan: MicrovmNetworkPlan): Promise<void>;
}

export interface MicrovmNetworkLifecycle {
  readonly plan: MicrovmNetworkPlan;
  setup(): Promise<MicrovmNetworkPlan>;
  cleanup(): Promise<void>;
  /**
   * Optional, best-effort, read-only diagnostic dump (live nftables
   * ruleset + interface counters) for troubleshooting a connectivity
   * failure while the namespace still exists (i.e. called before
   * `cleanup()`). Not required by every implementer/mock.
   */
  captureDiagnostics?(): Promise<string>;
}

export interface MicrovmNetworkCommandOptions {
  readonly reject: boolean;
  readonly input?: string;
}

export type MicrovmNetworkCommandExecutor = (
  command: string,
  args: readonly string[],
  options: MicrovmNetworkCommandOptions,
) => Promise<unknown>;

export interface MicrovmNetworkRulesetFile {
  write(contents: string): Promise<string>;
  remove(rulesetPath: string): Promise<void>;
}
