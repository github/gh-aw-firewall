/**
 * GHES Auto-Populate Integration Tests
 *
 * Tests that ENGINE_API_TARGET environment variable (set by GitHub Agentic Workflows)
 * automatically adds GHES domains and Copilot API domains to the firewall allowlist.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('GHES Auto-Populate', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should automatically add GHES domains when ENGINE_API_TARGET is set', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing GHES domain auto-population"',
      {
        allowDomains: [], // Explicitly empty - domains should come from ENGINE_API_TARGET
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://api.github.mycompany.com',
        },
      }
    );

    // Should succeed without any network calls
    expect(result.exitCode).toBe(0);

    // Should log the auto-added GHES domains
    expect(result.stderr).toContain('Auto-added GHES domains from engine.api-target');
    expect(result.stderr).toContain('github.mycompany.com');
    expect(result.stderr).toContain('api.github.mycompany.com');
  }, 120000);

  test('should add Copilot API domains when ENGINE_API_TARGET is set', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://api.githubcopilot.com',
      {
        allowDomains: [], // Explicitly empty
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://api.github.enterprise.local',
        },
      }
    );

    // Should allow Copilot API domains even on GHES
    expect(result).toAllowDomain('api.githubcopilot.com');
  }, 120000);

  test('should add enterprise Copilot API domains when ENGINE_API_TARGET is set', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://api.enterprise.githubcopilot.com',
      {
        allowDomains: [], // Explicitly empty
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://api.github.enterprise.local',
        },
      }
    );

    // Should allow enterprise Copilot API domains
    expect(result).toAllowDomain('api.enterprise.githubcopilot.com');
  }, 120000);

  test('should add telemetry Copilot API domains when ENGINE_API_TARGET is set', async () => {
    const result = await runner.runWithSudo(
      'curl -s https://telemetry.enterprise.githubcopilot.com',
      {
        allowDomains: [], // Explicitly empty
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://api.github.enterprise.local',
        },
      }
    );

    // Should allow telemetry Copilot API domains
    expect(result).toAllowDomain('telemetry.enterprise.githubcopilot.com');
  }, 120000);

  test('should not duplicate domains if already in allowlist', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing no duplication"',
      {
        allowDomains: ['github.mycompany.com', 'api.githubcopilot.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://api.github.mycompany.com',
        },
      }
    );

    expect(result.exitCode).toBe(0);

    // Count how many times each domain appears in the debug output
    const allowedDomainsLine = result.stderr
      .split('\n')
      .find(line => line.includes('Allowed domains:'));

    expect(allowedDomainsLine).toBeDefined();

    const ghesCount = ((allowedDomainsLine as string).match(/github\.mycompany\.com/g) || []).length;
    const copilotCount = ((allowedDomainsLine as string).match(/api\.githubcopilot\.com/g) || []).length;

    // Each domain should appear exactly once
    expect(ghesCount).toBe(1);
    expect(copilotCount).toBe(1);
  }, 120000);

  test('should combine ENGINE_API_TARGET domains with --allow-domains flag', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing combined domains"',
      {
        allowDomains: ['example.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://api.github.mycompany.com',
        },
      }
    );

    expect(result.exitCode).toBe(0);

    // Should include both explicit domains and auto-added GHES domains
    expect(result.stderr).toContain('example.com');
    expect(result.stderr).toContain('github.mycompany.com');
    expect(result.stderr).toContain('api.github.mycompany.com');
    expect(result.stderr).toContain('api.githubcopilot.com');
  }, 120000);

  test('should handle ENGINE_API_TARGET without api. prefix', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing non-api prefix"',
      {
        allowDomains: [],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'https://github.enterprise.local',
        },
      }
    );

    expect(result.exitCode).toBe(0);

    // Should still add Copilot API domains
    expect(result.stderr).toContain('api.githubcopilot.com');
    expect(result.stderr).toContain('api.enterprise.githubcopilot.com');
    expect(result.stderr).toContain('telemetry.enterprise.githubcopilot.com');

    // Should add the hostname itself
    expect(result.stderr).toContain('github.enterprise.local');
  }, 120000);

  test('should ignore invalid ENGINE_API_TARGET gracefully', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing invalid ENGINE_API_TARGET"',
      {
        allowDomains: ['github.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        env: {
          ENGINE_API_TARGET: 'not-a-valid-url',
        },
      }
    );

    // Should succeed with just the explicit domains
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('github.com');

    // Should not log GHES domain auto-population
    expect(result.stderr).not.toContain('Auto-added GHES domains from engine.api-target');
  }, 120000);

  test('should work without ENGINE_API_TARGET set', async () => {
    const result = await runner.runWithSudo(
      'echo "Testing without ENGINE_API_TARGET"',
      {
        allowDomains: ['github.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 60000,
        // No ENGINE_API_TARGET in env
      }
    );

    // Should succeed with just the explicit domains
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('github.com');

    // Should not log GHES domain auto-population
    expect(result.stderr).not.toContain('Auto-added GHES domains from engine.api-target');
  }, 120000);
});
