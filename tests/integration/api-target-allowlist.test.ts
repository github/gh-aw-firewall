/**
 * API Target Allowlist Integration Tests
 *
 * Tests that api-target values (--copilot-api-target, --openai-api-target, --anthropic-api-target)
 * are automatically added to the allowlist when specified.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('API Target Allowlist', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should automatically add copilot-api-target to allowlist', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://api.acme.ghe.com',
      {
        allowDomains: ['github.com'], // Note: NOT including api.acme.ghe.com
        copilotApiTarget: 'api.acme.ghe.com',
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          COPILOT_GITHUB_TOKEN: 'fake-token-for-test',
        },
      }
    );

    // Should succeed because api.acme.ghe.com was automatically added to allowlist
    expect(result).toAllowDomain('api.acme.ghe.com');
  }, 120000);

  test('should automatically add openai-api-target to allowlist', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://custom.openai-router.internal',
      {
        allowDomains: ['github.com'], // Note: NOT including custom.openai-router.internal
        openaiApiTarget: 'custom.openai-router.internal',
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          OPENAI_API_KEY: 'sk-fake-test-key',
        },
      }
    );

    // Should succeed because custom.openai-router.internal was automatically added to allowlist
    expect(result).toAllowDomain('custom.openai-router.internal');
  }, 120000);

  test('should automatically add anthropic-api-target to allowlist', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://custom.anthropic-router.internal',
      {
        allowDomains: ['github.com'], // Note: NOT including custom.anthropic-router.internal
        anthropicApiTarget: 'custom.anthropic-router.internal',
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-fake-test-key',
        },
      }
    );

    // Should succeed because custom.anthropic-router.internal was automatically added to allowlist
    expect(result).toAllowDomain('custom.anthropic-router.internal');
  }, 120000);

  test('should add api-target from environment variable to allowlist', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://api.env-test.ghe.com',
      {
        allowDomains: ['github.com'], // Note: NOT including api.env-test.ghe.com
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          COPILOT_GITHUB_TOKEN: 'fake-token-for-test',
          COPILOT_API_TARGET: 'api.env-test.ghe.com', // Set via env var instead of flag
        },
      }
    );

    // Should succeed because api.env-test.ghe.com from env var was automatically added to allowlist
    expect(result).toAllowDomain('api.env-test.ghe.com');
  }, 120000);

  test('should not add default api-targets to allowlist automatically', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://api.githubcopilot.com',
      {
        allowDomains: ['github.com'], // Note: NOT including default api.githubcopilot.com
        enableApiProxy: false, // No custom api-target specified
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    // Should be blocked because default api-targets are NOT automatically added
    expect(result).toBlockDomain('api.githubcopilot.com');
  }, 120000);

  test('should not duplicate domains if api-target is already in allowlist', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://api.custom.com',
      {
        allowDomains: ['api.custom.com', 'github.com'], // Already includes api.custom.com
        copilotApiTarget: 'api.custom.com',
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          COPILOT_GITHUB_TOKEN: 'fake-token-for-test',
        },
      }
    );

    // Should succeed and not create duplicates
    expect(result).toAllowDomain('api.custom.com');

    // Verify no duplicate in debug output (should only appear once in "Allowed domains:" line)
    const allowedDomainsLine = result.stderr
      .split('\n')
      .find(line => line.includes('Allowed domains:'));

    if (allowedDomainsLine) {
      const domainCount = (allowedDomainsLine.match(/api\.custom\.com/g) || []).length;
      expect(domainCount).toBe(1);
    }
  }, 120000);

  test('should add multiple api-targets when multiple are specified', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing multiple api-targets"',
      {
        allowDomains: ['github.com'],
        copilotApiTarget: 'api.copilot.custom.com',
        openaiApiTarget: 'api.openai.custom.com',
        anthropicApiTarget: 'api.anthropic.custom.com',
        enableApiProxy: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          COPILOT_GITHUB_TOKEN: 'fake-token',
          OPENAI_API_KEY: 'sk-fake-key',
          ANTHROPIC_API_KEY: 'sk-ant-fake-key',
        },
      }
    );

    // All three custom api-targets should be in the allowlist
    expect(result.stderr).toContain('api.copilot.custom.com');
    expect(result.stderr).toContain('api.openai.custom.com');
    expect(result.stderr).toContain('api.anthropic.custom.com');

    // Should see debug log messages for each auto-added domain
    expect(result.stderr).toContain('Automatically added API target to allowlist');
  }, 120000);
});
