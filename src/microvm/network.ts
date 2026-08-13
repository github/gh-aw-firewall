// Re-export public API for backwards compatibility.
// Test files should import directly from the focused source modules.

export { LinuxNetworkCommands } from './network-commands';
export { MicrovmNetworkManager } from './network-manager';
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
  MicrovmNetworkPlanOptions,
  MicrovmNetworkRulesetFile,
  MicrovmTapInterface,
} from './network-types';
