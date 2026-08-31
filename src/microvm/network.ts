// Re-export public API for backwards compatibility.
// Test files should import directly from the focused source modules.

export { LinuxNetworkCommands } from './network-commands';
export { MicrovmNetworkManager } from './network-manager';
export {
  MicrovmNetworkReservationRegistry,
  reserveMicrovmNetworkPlan,
} from './network-reservation';
export {
  assertSafeMicrovmRunId,
  createMicrovmNetworkPlan,
  generateMicrovmNftRuleset,
} from './network-plan';
export type {
  MicrovmAllowedEndpoint,
  MicrovmConnectivityProbe,
  MicrovmControlPeer,
  MicrovmNetworkCommandExecutor,
  MicrovmNetworkCommandOptions,
  MicrovmNetworkHostTools,
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
  MicrovmNetworkPlanAllocation,
  MicrovmNetworkPlanOptions,
  MicrovmNetworkResourceObserver,
  MicrovmNetworkReservation,
  MicrovmNetworkRulesetFile,
  MicrovmTapInterface,
} from './network-types';
