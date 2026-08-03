/**
 * Tests for the AWF-internal domain filter.
 */

import { isInternalAwfDomain } from './internal-domain-filter';

describe('isInternalAwfDomain', () => {
  describe('AWF Docker network IPs (172.30.0.0/24)', () => {
    it('returns true for the Squid proxy IP', () => {
      expect(isInternalAwfDomain('172.30.0.10')).toBe(true);
    });

    it('returns true for the agent IP', () => {
      expect(isInternalAwfDomain('172.30.0.20')).toBe(true);
    });

    it('returns true for the api-proxy IP', () => {
      expect(isInternalAwfDomain('172.30.0.30')).toBe(true);
    });

    it('returns true for the network gateway IP (172.30.0.1)', () => {
      expect(isInternalAwfDomain('172.30.0.1')).toBe(true);
    });

    it('returns true for any IP in 172.30.0.0/24', () => {
      expect(isInternalAwfDomain('172.30.0.0')).toBe(true);
      expect(isInternalAwfDomain('172.30.0.100')).toBe(true);
      expect(isInternalAwfDomain('172.30.0.255')).toBe(true);
    });

    it('returns false for IPs outside the AWF subnet', () => {
      expect(isInternalAwfDomain('172.30.1.1')).toBe(false);
      expect(isInternalAwfDomain('172.31.0.10')).toBe(false);
      expect(isInternalAwfDomain('10.0.0.1')).toBe(false);
      expect(isInternalAwfDomain('192.168.1.1')).toBe(false);
      expect(isInternalAwfDomain('1.2.3.4')).toBe(false);
    });
  });

  describe('single-label Docker container hostnames (no dots)', () => {
    it('returns true for the MCP Gateway hostname (awmgmcpg)', () => {
      expect(isInternalAwfDomain('awmgmcpg')).toBe(true);
    });

    it('returns true for the MCP Gateway hostname with dash (awmg-mcpg)', () => {
      expect(isInternalAwfDomain('awmg-mcpg')).toBe(true);
    });

    it('returns true for other single-label Docker hostnames', () => {
      expect(isInternalAwfDomain('mycontainer')).toBe(true);
      expect(isInternalAwfDomain('awmg-cli-proxy')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isInternalAwfDomain('')).toBe(false);
    });
  });

  describe('known topology peers (dotted names from policy manifest)', () => {
    it('returns true for a dotted topology peer when present in the known set', () => {
      const peers = new Set(['mcp.gateway-01']);
      expect(isInternalAwfDomain('mcp.gateway-01', peers)).toBe(true);
    });

    it('matching is case-insensitive', () => {
      const peers = new Set(['mcp.gateway-01']);
      expect(isInternalAwfDomain('MCP.Gateway-01', peers)).toBe(true);
    });

    it('returns false for a dotted name NOT in the known set', () => {
      const peers = new Set(['mcp.gateway-01']);
      expect(isInternalAwfDomain('evil.com', peers)).toBe(false);
    });

    it('returns false for a dotted peer name when no known set is provided', () => {
      // Without a manifest, dotted names are not filtered — the single-label
      // heuristic cannot catch them. This is the gap fixed by passing peers.
      expect(isInternalAwfDomain('mcp.gateway-01')).toBe(false);
    });

    it('returns true for a single-label peer even without the known set (heuristic)', () => {
      expect(isInternalAwfDomain('awmg-mcpg')).toBe(true);
    });

    it('returns true for a dotted peer with an empty known set (falls through to single-label check)', () => {
      // Empty set → no topology peer match; 'awmg-mcpg' still matched by heuristic
      const emptyPeers = new Set<string>();
      expect(isInternalAwfDomain('awmg-mcpg', emptyPeers)).toBe(true);
    });
  });

  describe('public internet domains (should not be filtered)', () => {
    it('returns false for standard external domains', () => {
      expect(isInternalAwfDomain('github.com')).toBe(false);
      expect(isInternalAwfDomain('api.github.com')).toBe(false);
      expect(isInternalAwfDomain('npmjs.org')).toBe(false);
      expect(isInternalAwfDomain('evil.com')).toBe(false);
    });

    it('returns false for subdomains', () => {
      expect(isInternalAwfDomain('registry-1.docker.io')).toBe(false);
      expect(isInternalAwfDomain('objects.githubusercontent.com')).toBe(false);
    });

    it('returns false for the dash placeholder domain', () => {
      expect(isInternalAwfDomain('-')).toBe(false);
    });

    it('returns false for IPv6 addresses (bracketed)', () => {
      expect(isInternalAwfDomain('[::1]')).toBe(false);
      expect(isInternalAwfDomain('[2001:db8::1]')).toBe(false);
    });

    it('returns false for IPv6 addresses (bare)', () => {
      expect(isInternalAwfDomain('::1')).toBe(false);
    });
  });
});
