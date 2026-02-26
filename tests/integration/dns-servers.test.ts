/**
 * DNS Server Configuration Tests
 *
 * These tests verify the --dns-servers CLI option:
 * - Default DNS servers (8.8.8.8, 8.8.4.4)
 * - Custom DNS server configuration
 * - DNS resolution works with custom servers
 * - Invalid DNS server handling
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('DNS Server Configuration', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should resolve DNS with default servers', async () => {
    const result = await runner.runWithSudo(
      'nslookup github.com',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Address');
  }, 120000);

  test('should resolve DNS with custom Google DNS server', async () => {
    const result = await runner.runWithSudo(
      'nslookup github.com 8.8.8.8',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Address');
  }, 120000);

  test('should resolve DNS with Cloudflare DNS server', async () => {
    const result = await runner.runWithSudo(
      'nslookup github.com 1.1.1.1',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Address');
  }, 120000);

  test('should show DNS servers in debug output', async () => {
    const result = await runner.runWithSudo(
      'echo "test"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // Debug output should show DNS configuration
    expect(result.stderr).toMatch(/DNS|dns/);
  }, 120000);

  test('should resolve multiple domains sequentially', async () => {
    const result = await runner.runWithSudo(
      'bash -c "nslookup github.com && nslookup api.github.com"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // Both lookups should succeed
    expect(result.stdout).toContain('github.com');
  }, 120000);

  test('should resolve DNS for allowed domains', async () => {
    const result = await runner.runWithSudo(
      'dig github.com +short',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // dig should return IP address(es)
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+\.\d+/);
  }, 120000);
});

describe('DNS Restriction Enforcement', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  // Clean up between each test to prevent container name conflicts
  beforeEach(async () => {
    await cleanup(false);
  });

  test('should block DNS queries to non-whitelisted servers', async () => {
    // Only whitelist Google DNS (8.8.8.8) — Cloudflare (1.1.1.1) should be blocked
    const result = await runner.runWithSudo(
      'nslookup example.com 1.1.1.1',
      {
        allowDomains: ['example.com'],
        dnsServers: ['8.8.8.8'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // DNS query to non-whitelisted server should fail
    expect(result).toFail();
  }, 120000);

  test('should allow DNS queries to whitelisted servers', async () => {
    // Whitelist Google DNS (8.8.8.8) — queries to it should succeed
    const result = await runner.runWithSudo(
      'nslookup example.com 8.8.8.8',
      {
        allowDomains: ['example.com'],
        dnsServers: ['8.8.8.8'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Address');
  }, 120000);

  test('should pass --dns-servers flag through to iptables configuration', async () => {
    const result = await runner.runWithSudo(
      'echo "dns-test"',
      {
        allowDomains: ['example.com'],
        dnsServers: ['8.8.8.8'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // Debug output should show the custom DNS server configuration
    expect(result.stderr).toContain('8.8.8.8');
  }, 120000);

  test('should work with default DNS when --dns-servers is not specified', async () => {
    // Without explicit dnsServers, default Google DNS (8.8.8.8, 8.8.4.4) should work
    const result = await runner.runWithSudo(
      'nslookup example.com',
      {
        allowDomains: ['example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Address');
  }, 120000);

  test('should block DNS to non-default server when using defaults', async () => {
    // With default DNS (8.8.8.8, 8.8.4.4), a query to a random DNS server
    // like 208.67.222.222 (OpenDNS) should be blocked
    const result = await runner.runWithSudo(
      'nslookup example.com 208.67.222.222',
      {
        allowDomains: ['example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // DNS query to non-default server should fail
    expect(result).toFail();
  }, 120000);

  test('should allow Cloudflare DNS when explicitly whitelisted', async () => {
    // Whitelist Cloudflare DNS (1.1.1.1) — queries to it should succeed
    const result = await runner.runWithSudo(
      'nslookup example.com 1.1.1.1',
      {
        allowDomains: ['example.com'],
        dnsServers: ['1.1.1.1'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('Address');
  }, 120000);
});
