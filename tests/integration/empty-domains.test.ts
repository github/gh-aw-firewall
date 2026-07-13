/**
 * Empty Domains Tests
 *
 * These tests verify the behavior when no domains are allowed:
 * - All network access should be blocked
 * - Commands that don't require network should still work
 * - Debug logs should indicate no domains are configured
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Empty Domains (No Network Access)', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Network Blocking', () => {
    test('should block all network access when no domains are specified', async () => {
      // Try to access a website without any allowed domains
      const result = await runner.run(
        'curl -f --max-time 5 https://example.com',
        {
          allowDomains: [], // Empty domains list
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Request should fail because no domains are allowed
      expect(result).toFail();
    }, 120000);

    test('should block HTTPS traffic when no domains are specified', async () => {
      const result = await runner.run(
        'curl -f --max-time 5 https://api.github.com/zen',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block HTTP traffic when no domains are specified', async () => {
      const result = await runner.run(
        'curl -f --max-time 5 http://httpbin.org/get',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);
  });

  describe('Offline Commands', () => {
    test('should allow commands that do not require network access', async () => {
      const result = await runner.run(
        'echo "Hello, offline world!"',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('Hello, offline world!');
    }, 120000);

    test('should allow file system operations without network', async () => {
      const result = await runner.run(
        'bash -c "echo test > /tmp/test.txt && cat /tmp/test.txt && rm /tmp/test.txt"',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('test');
    }, 120000);

    test('should allow local computations without network', async () => {
      const result = await runner.run(
        'bash -c "expr 2 + 2"',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('4');
    }, 120000);
  });

  describe('Debug Output', () => {
    test('should indicate no domains are configured in debug output', async () => {
      const result = await runner.run(
        'echo "test"',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Should show debug message about no domains
      expect(result.stderr).toMatch(/No allowed domains specified|all network access will be blocked/i);
    }, 120000);
  });

  describe('DNS Behavior', () => {
    test('should block network access even when DNS resolution succeeds', async () => {
      // DNS lookups should work (we allow DNS traffic), but connecting should fail
      // because the domain isn't in the allowlist
      const result = await runner.run(
        'bash -c "host example.com > /dev/null 2>&1 && curl -f --max-time 5 https://example.com || echo network_blocked"',
        {
          allowDomains: [],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // The network request should be blocked
      expect(result.stdout).toContain('network_blocked');
    }, 120000);
  });
});
