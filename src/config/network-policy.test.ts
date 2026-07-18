import {
  networkPolicy,
  NETWORK_NAME,
  EXTERNAL_BRIDGE_NAME,
  NETWORK_SUBNET,
  SQUID_IP,
  AGENT_IP,
  API_PROXY_IP,
  DOH_PROXY_IP,
  CLI_PROXY_IP,
  SQUID_PORT,
  CLI_PROXY_PORT,
  DOH_UPSTREAM_PORT,
  EMBEDDED_DNS_RESOLVER,
  DEFAULT_DNS_SERVERS,
  DNS_PORT,
  API_PROXY_HEALTH_PORT,
  HOST_GATEWAY,
  apiProxyPorts,
  blockedPortNumbers,
  blockedCidrs,
} from './network-policy';

import * as iptablesShared from '../host-iptables-shared';
import { SQUID_PORT as CONSTANTS_SQUID_PORT } from '../constants';
import { DEFAULT_DNS_SERVERS as RESOLVER_DEFAULT_DNS } from '../dns-resolver';
import { TOPOLOGY_NETWORK_NAME } from '../topology';
import { API_PROXY_PORTS, API_PROXY_HEALTH_PORT as PORTS_HEALTH, CLI_PROXY_PORT as PORTS_CLI } from '../types/ports';

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Returns true if `ip` falls inside the /24 CIDR `subnet` (e.g. 172.30.0.0/24). */
function ipInSubnet24(ip: string, subnet: string): boolean {
  const [net] = subnet.split('/');
  const netPrefix = net.split('.').slice(0, 3).join('.');
  const ipPrefix = ip.split('.').slice(0, 3).join('.');
  return netPrefix === ipPrefix;
}

describe('network-policy', () => {
  describe('loads and validates the JSON', () => {
    it('exposes a frozen, fully-typed policy', () => {
      expect(networkPolicy.topology.networkName).toBe('awf-net');
      expect(networkPolicy.proxies.squid.port).toBe(3128);
      expect(networkPolicy.dns.embeddedResolver).toBe('127.0.0.11');
      expect(networkPolicy.legacyIptables.blockedPorts.length).toBeGreaterThan(0);
    });

    it('deeply freezes the policy tree, including nested objects and arrays', () => {
      expect(Object.isFrozen(networkPolicy)).toBe(true);
      expect(Object.isFrozen(networkPolicy.topology)).toBe(true);
      expect(Object.isFrozen(networkPolicy.topology.hosts)).toBe(true);
      expect(Object.isFrozen(networkPolicy.topology.hosts.squid)).toBe(true);
      expect(Object.isFrozen(networkPolicy.proxies.apiProxy.ports)).toBe(true);
      expect(Object.isFrozen(networkPolicy.dns.defaultUpstreamServers)).toBe(true);
      expect(Object.isFrozen(networkPolicy.legacyIptables.blockedPorts)).toBe(true);
      expect(Object.isFrozen(networkPolicy.legacyIptables.blockedPorts[0])).toBe(true);
    });

    it('prevents live accessors from diverging via mutation', () => {
      // The object returned by apiProxyPorts() is the frozen policy node, so a
      // stray mutation cannot silently change it out from under other callers.
      expect(Object.isFrozen(apiProxyPorts())).toBe(true);
      expect(() => {
        (apiProxyPorts() as { openai: number }).openai = 1;
      }).toThrow();
    });
  });

  describe('topology invariants', () => {
    const hosts = networkPolicy.topology.hosts;

    it('assigns every host a valid IPv4 within the subnet', () => {
      for (const [name, host] of Object.entries(hosts)) {
        expect(host.ip).toMatch(IPV4);
        expect(ipInSubnet24(host.ip, networkPolicy.topology.subnet)).toBe(true);
        expect(name).toBeTruthy();
      }
    });

    it('assigns unique IPs to all hosts', () => {
      const ips = Object.values(hosts).map((h) => h.ip);
      expect(new Set(ips).size).toBe(ips.length);
    });

    it('marks squid and agent required, sidecars optional', () => {
      expect(hosts.squid.required).toBe(true);
      expect(hosts.agent.required).toBe(true);
      expect(hosts.apiProxy.required).toBe(false);
      expect(hosts.dohProxy.required).toBe(false);
      expect(hosts.cliProxy.required).toBe(false);
    });

    it('dual-homes only squid (the sole egress)', () => {
      expect(hosts.squid.dualHomed).toBe(true);
      for (const [name, host] of Object.entries(hosts)) {
        if (name !== 'squid') expect(host.dualHomed).toBeUndefined();
      }
    });
  });

  describe('port invariants', () => {
    it('keeps every port in the valid 1-65535 range', () => {
      const allPorts = [
        SQUID_PORT,
        CLI_PROXY_PORT,
        DOH_UPSTREAM_PORT,
        DNS_PORT,
        API_PROXY_HEALTH_PORT,
        ...Object.values(apiProxyPorts()),
        ...blockedPortNumbers(),
      ];
      for (const port of allPorts) {
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThanOrEqual(1);
        expect(port).toBeLessThanOrEqual(65535);
      }
    });

    it('uses the OpenAI port as the API proxy health port', () => {
      expect(API_PROXY_HEALTH_PORT).toBe(apiProxyPorts().openai);
    });

    it('keeps the CLI proxy port clear of the api-proxy range', () => {
      const api = Object.values(apiProxyPorts());
      expect(api).not.toContain(CLI_PROXY_PORT);
    });

    it('assigns unique api-proxy provider ports', () => {
      const api = Object.values(apiProxyPorts());
      expect(new Set(api).size).toBe(api.length);
    });
  });

  describe('legacy iptables deny lists', () => {
    it('lists unique blocked ports', () => {
      const ports = blockedPortNumbers();
      expect(new Set(ports).size).toBe(ports.length);
    });

    it('blocks the well-known dangerous ports', () => {
      // Guards against silent drops from the historical DANGEROUS_PORTS list.
      for (const p of [22, 23, 25, 445, 1433, 3306, 3389, 5432, 6379, 27017]) {
        expect(blockedPortNumbers()).toContain(p);
      }
    });

    it('blocks the cloud metadata / link-local and multicast ranges', () => {
      expect(blockedCidrs()).toContain('169.254.0.0/16');
      expect(blockedCidrs()).toContain('224.0.0.0/4');
    });

    it('lists unique blocked CIDRs', () => {
      const cidrs = blockedCidrs();
      expect(new Set(cidrs).size).toBe(cidrs.length);
    });
  });

  describe('non-behavioral refactor parity', () => {
    it('preserves the historical topology constants', () => {
      expect(NETWORK_NAME).toBe('awf-net');
      expect(EXTERNAL_BRIDGE_NAME).toBe('awf-ext');
      expect(NETWORK_SUBNET).toBe('172.30.0.0/24');
      expect(HOST_GATEWAY).toBe('172.30.0.1');
      expect(SQUID_IP).toBe('172.30.0.10');
      expect(AGENT_IP).toBe('172.30.0.20');
      expect(API_PROXY_IP).toBe('172.30.0.30');
      expect(DOH_PROXY_IP).toBe('172.30.0.40');
      expect(CLI_PROXY_IP).toBe('172.30.0.50');
    });

    it('preserves the historical port constants', () => {
      expect(SQUID_PORT).toBe(3128);
      expect(CLI_PROXY_PORT).toBe(11000);
      expect(DOH_UPSTREAM_PORT).toBe(443);
      expect(apiProxyPorts()).toEqual({
        openai: 10000,
        anthropic: 10001,
        copilot: 10002,
        gemini: 10003,
        vertex: 10004,
      });
    });

    it('preserves the historical DNS constants', () => {
      expect(EMBEDDED_DNS_RESOLVER).toBe('127.0.0.11');
      expect(DEFAULT_DNS_SERVERS).toEqual(['8.8.8.8', '8.8.4.4']);
      expect(DNS_PORT).toBe(53);
    });

    it('returns a fresh mutable DEFAULT_DNS_SERVERS array each import site can pass by value', () => {
      expect(Array.isArray(DEFAULT_DNS_SERVERS)).toBe(true);
      // Not the frozen policy array — callers historically received a mutable list.
      expect(DEFAULT_DNS_SERVERS).not.toBe(networkPolicy.dns.defaultUpstreamServers);
    });
  });

  describe('downstream modules stay in sync with the policy', () => {
    it('host-iptables-shared re-exports the same topology values', () => {
      expect(iptablesShared.NETWORK_NAME).toBe(NETWORK_NAME);
      expect(iptablesShared.NETWORK_SUBNET).toBe(NETWORK_SUBNET);
      expect(iptablesShared.AWF_NETWORK_GATEWAY).toBe(HOST_GATEWAY);
      expect(iptablesShared.SQUID_IP).toBe(SQUID_IP);
      expect(iptablesShared.AGENT_IP).toBe(AGENT_IP);
      expect(iptablesShared.API_PROXY_IP).toBe(API_PROXY_IP);
      expect(iptablesShared.DOH_PROXY_IP).toBe(DOH_PROXY_IP);
      expect(iptablesShared.CLI_PROXY_IP).toBe(CLI_PROXY_IP);
    });

    it('constants, dns-resolver and topology re-export policy values', () => {
      expect(CONSTANTS_SQUID_PORT).toBe(SQUID_PORT);
      expect(RESOLVER_DEFAULT_DNS).toEqual(DEFAULT_DNS_SERVERS);
      expect(TOPOLOGY_NETWORK_NAME).toBe(NETWORK_NAME);
    });

    it('types/ports maps the policy into the historical shape', () => {
      expect(API_PROXY_PORTS).toEqual({
        OPENAI: 10000,
        ANTHROPIC: 10001,
        COPILOT: 10002,
        GEMINI: 10003,
        VERTEX: 10004,
      });
      expect(PORTS_HEALTH).toBe(API_PROXY_HEALTH_PORT);
      expect(PORTS_CLI).toBe(CLI_PROXY_PORT);
    });
  });
});
