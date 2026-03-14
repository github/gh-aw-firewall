/**
 * GH_HOST Auto-Injection Tests
 *
 * These tests verify that GH_HOST is automatically set in the agent container
 * when GITHUB_SERVER_URL points to a GHES/GHEC instance (non-github.com).
 * This ensures the gh CLI inside the container targets the correct GitHub instance.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('GH_HOST Auto-Injection', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should set GH_HOST for GHEC instance (*.ghe.com)', async () => {
    const result = await runner.runWithSudo(
      'echo $GH_HOST',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          GITHUB_SERVER_URL: 'https://acme.ghe.com',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('acme.ghe.com');
  }, 120000);

  test('should set GH_HOST for GHES instance', async () => {
    const result = await runner.runWithSudo(
      'echo $GH_HOST',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          GITHUB_SERVER_URL: 'https://github.company.com',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('github.company.com');
  }, 120000);

  test('should set GH_HOST for GHES instance with custom port', async () => {
    const result = await runner.runWithSudo(
      'echo $GH_HOST',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          GITHUB_SERVER_URL: 'https://github.internal:8443',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('github.internal');
  }, 120000);

  test('should not set GH_HOST for public github.com', async () => {
    const result = await runner.runWithSudo(
      'bash -c "if [ -z \\"$GH_HOST\\" ]; then echo GH_HOST_NOT_SET; else echo GH_HOST=$GH_HOST; fi"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          GITHUB_SERVER_URL: 'https://github.com',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('GH_HOST_NOT_SET');
  }, 120000);

  test('should not set GH_HOST when GITHUB_SERVER_URL is not set', async () => {
    const result = await runner.runWithSudo(
      'bash -c "if [ -z \\"$GH_HOST\\" ]; then echo GH_HOST_NOT_SET; else echo GH_HOST=$GH_HOST; fi"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        // No GITHUB_SERVER_URL set
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('GH_HOST_NOT_SET');
  }, 120000);

  test('should log debug message when GH_HOST is auto-injected', async () => {
    const result = await runner.runWithSudo(
      'echo "test"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          GITHUB_SERVER_URL: 'https://github.enterprise.local',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stderr).toContain('Auto-injected GH_HOST=github.enterprise.local');
  }, 120000);

  test('should work with --env-all flag', async () => {
    const result = await runner.runWithSudo(
      'echo $GH_HOST',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        envAll: true,
        env: {
          GITHUB_SERVER_URL: 'https://mycompany.ghe.com',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('mycompany.ghe.com');
  }, 120000);

  test('should handle GITHUB_SERVER_URL with trailing slash', async () => {
    const result = await runner.runWithSudo(
      'echo $GH_HOST',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          GITHUB_SERVER_URL: 'https://github.enterprise.org/',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('github.enterprise.org');
  }, 120000);
});
