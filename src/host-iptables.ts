// Re-export public API only. Test files should import directly from source
// modules (host-iptables-rules, host-iptables-network, etc.).

export { setupHostIptables } from './host-iptables-rules';
export type {
  HostAccessConfig,
  CliProxyHostConfig,
} from './host-iptables-rules';
export { ensureFirewallNetwork } from './host-iptables-network';
export { cleanupHostIptables } from './host-iptables-cleanup';
