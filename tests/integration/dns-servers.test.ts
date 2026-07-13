/**
 * DNS Server Configuration Tests
 *
 * These tests verify the simplified DNS security model:
 * - Docker embedded DNS (127.0.0.11) handles all name resolution
 * - Direct DNS queries to external servers are blocked
 * - DNS resolution via Docker embedded DNS still works for allowed domains
 * - The --dns-servers flag configures Docker embedded DNS forwarding
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('DNS Resolution via Docker Embedded DNS', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should resolve DNS for allowed domains via Docker embedded DNS', async () => {
    // DNS resolution uses Docker embedded DNS (127.0.0.11) which forwards
    // to upstream servers configured via docker-compose dns: field
    const result = await runner.run(
      'dig github.com +short',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+\.\d+/);
  }, 120000);

  test('should resolve multiple domains sequentially', async () => {
    const result = await runner.run(
      'bash -c "dig github.com +short && dig api.github.com +short"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+\.\d+/);
  }, 120000);

  test('should resolve DNS with dig command via Docker embedded DNS', async () => {
    const result = await runner.run(
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

  test('should show DNS configuration in debug output', async () => {
    const result = await runner.run(
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

  test('should work with custom DNS servers for Docker forwarding', async () => {
    // Custom --dns-servers configures Docker embedded DNS upstream forwarding
    const result = await runner.run(
      'dig github.com +short',
      {
        allowDomains: ['github.com'],
        dnsServers: ['1.1.1.1'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+\.\d+/);
  }, 120000);
});

describe('DNS Exfiltration Prevention', () => {
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

  test('should block direct DNS queries to non-configured DNS servers (Quad9)', async () => {
    // Direct DNS to non-configured servers should be blocked.
    // In network-isolation mode the internal network has no route to external IPs.
    const result = await runner.run(
      'dig @9.9.9.9 example.com +short +timeout=5',
      {
        allowDomains: ['example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // Direct DNS query to non-configured server should fail
    expect(result).toFail();
  }, 120000);

  test('should block direct DNS queries to OpenDNS', async () => {
    // OpenDNS (208.67.222.222) is not reachable from the internal network
    const result = await runner.run(
      'dig @208.67.222.222 example.com +short +timeout=5',
      {
        allowDomains: ['example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // DNS query to non-configured external server should fail
    expect(result).toFail();
  }, 120000);

  test('should block direct DNS queries to Cloudflare when not configured', async () => {
    // Cloudflare DNS (1.1.1.1) is not reachable from the internal network
    const result = await runner.run(
      'dig @1.1.1.1 example.com +short +timeout=5',
      {
        allowDomains: ['example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // Direct DNS query to non-configured server should fail
    expect(result).toFail();
  }, 120000);

  test('should pass --dns-servers flag through to configuration', async () => {
    const result = await runner.run(
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
});
