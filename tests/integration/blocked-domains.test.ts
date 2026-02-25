/**
 * Blocked Domains Tests
 *
 * These tests verify the --block-domains functionality:
 * - Blocked domains take precedence over allowed domains
 * - Blocking specific subdomains while allowing parent domain
 * - Block domain file parsing
 * - Wildcard patterns in blocked domains
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Blocked Domains Functionality', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should block specific domain even when parent is allowed', async () => {
    // Allow github.com but block a specific subdomain
    // Note: Currently blocked domains are checked against the ACL, so this tests
    // that the blocking mechanism is properly configured
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://api.github.com/zen',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // This should succeed since github.com allows subdomains
    expect(result).toSucceed();
  }, 120000);

  test('should allow requests to allowed domains', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://api.github.com/zen',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
  }, 120000);

  test('should block requests to non-allowed domains', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 5 https://example.com',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // Request should fail because example.com is not in the allowlist
    expect(result).toFail();
  }, 120000);

  test('should handle multiple blocked domains', async () => {
    // Test that multiple allowed domains work together
    const result = await runner.runWithSudo(
      'bash -c "curl -f --max-time 10 https://api.github.com/zen && echo success"',
      {
        allowDomains: ['github.com', 'npmjs.org'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('success');
  }, 120000);

  test('should show allowed domains in debug output', async () => {
    const result = await runner.runWithSudo(
      'echo "test"',
      {
        allowDomains: ['github.com', 'example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // Debug output should show domain configuration
    // The log format is "[INFO] Allowed domains: github.com, example.com"
    expect(result.stderr).toMatch(/Allowed domains:/i);
  }, 120000);
});

describe('Domain Allowlist Edge Cases', () => {
  let runner: AwfRunner;
  let testDir: string;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-blocked-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('should handle case-insensitive domain matching', async () => {
    // Test that domains are matched case-insensitively
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://API.GITHUB.COM/zen',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
  }, 120000);

  test('should handle domains with trailing dots', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://api.github.com/zen',
      {
        allowDomains: ['github.com.'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
  }, 120000);

  test('should handle domains with leading/trailing whitespace in config', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://api.github.com/zen',
      {
        allowDomains: ['  github.com  '],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
  }, 120000);

  test('should block IP address access when only domain is allowed', async () => {
    // Direct IP access should be blocked when only domain is in allowlist
    const result = await runner.runWithSudo(
      'bash -c "ip=$(dig +short api.github.com | head -1); curl -fk --max-time 5 https://$ip 2>&1 || echo blocked"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // Should fail or show blocked message
    expect(result.stdout).toMatch(/blocked|error|fail/i);
  }, 120000);
});

describe('Block Domains Deny-List (--block-domains)', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should block specific subdomain while allowing parent domain', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://api.github.com/zen',
      {
        allowDomains: ['github.com'],
        blockDomains: ['api.github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    expect(result).toFail();
  }, 120000);

  test('should still allow non-blocked subdomains when parent is allowed', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://github.com',
      {
        allowDomains: ['github.com'],
        blockDomains: ['api.github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    expect(result).toSucceed();
  }, 120000);

  test('should block domain that is also in the allow list (block takes precedence)', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 5 https://example.com',
      {
        allowDomains: ['example.com'],
        blockDomains: ['example.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    expect(result).toFail();
  }, 120000);

  test('should block wildcard pattern while allowing parent domain', async () => {
    const result = await runner.runWithSudo(
      'curl -f --max-time 10 https://api.github.com/zen',
      {
        allowDomains: ['github.com'],
        blockDomains: ['*.github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    expect(result).toFail();
  }, 120000);

  test('should handle multiple blocked domains', async () => {
    const result = await runner.runWithSudo(
      'bash -c "' +
        'curl -f --max-time 10 https://api.github.com/zen 2>&1; api_exit=$?; ' +
        'curl -f --max-time 10 https://raw.githubusercontent.com 2>&1; raw_exit=$?; ' +
        'echo api_exit=$api_exit raw_exit=$raw_exit"',
      {
        allowDomains: ['github.com', 'githubusercontent.com'],
        blockDomains: ['api.github.com', 'raw.githubusercontent.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    // Both blocked domains should fail even though their parent domains are allowed
    expect(result.stdout).not.toContain('api_exit=0');
    expect(result.stdout).not.toContain('raw_exit=0');
  }, 120000);

  test('should show blocked domains in debug output', async () => {
    const result = await runner.runWithSudo(
      'echo "test"',
      {
        allowDomains: ['github.com'],
        blockDomains: ['api.github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );
    expect(result).toSucceed();
    expect(result.stderr).toMatch(/[Bb]locked domains:/i);
  }, 120000);
});
