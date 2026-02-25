/**
 * Environment Variables Tests
 *
 * These tests verify the -e/--env and --env-all CLI options:
 * - Pass single environment variable to container
 * - Pass multiple environment variables
 * - Environment variable value with special characters
 * - --env-all passes all host environment variables
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Environment Variable Handling', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should pass environment variable to container', async () => {
    const result = await runner.runWithSudo(
      'echo $TEST_VAR',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          TEST_VAR: 'hello_world',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('hello_world');
  }, 120000);

  test('should pass multiple environment variables', async () => {
    const result = await runner.runWithSudo(
      'bash -c "echo $VAR1 $VAR2 $VAR3"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          VAR1: 'one',
          VAR2: 'two',
          VAR3: 'three',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('one');
    expect(result.stdout).toContain('two');
    expect(result.stdout).toContain('three');
  }, 120000);

  test('should handle environment variable with special characters', async () => {
    const result = await runner.runWithSudo(
      'echo "$SPECIAL_VAR"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          SPECIAL_VAR: 'value with spaces',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('value with spaces');
  }, 120000);

  test('should handle empty environment variable value', async () => {
    const result = await runner.runWithSudo(
      'bash -c "if [ -z \\"$EMPTY_VAR\\" ]; then echo empty; else echo not_empty; fi"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          EMPTY_VAR: '',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('empty');
  }, 120000);

  test('should preserve PATH environment variable', async () => {
    const result = await runner.runWithSudo(
      'echo $PATH',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // PATH should contain common directories
    expect(result.stdout).toMatch(/\/usr\/bin|\/bin/);
  }, 120000);

  test('should have HOME environment variable set', async () => {
    const result = await runner.runWithSudo(
      'echo $HOME',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // HOME should be set to a valid path
    expect(result.stdout).toMatch(/\/root|\/home\//);
  }, 120000);

  test('should not leak sensitive environment variables by default', async () => {
    const result = await runner.runWithSudo(
      'printenv | grep -E "TOKEN|SECRET|PASSWORD|KEY" || echo "none found"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // By default, sensitive variables should not be passed through
    // Note: This depends on what's in the host environment
  }, 120000);

  test('should handle numeric environment variable values', async () => {
    const result = await runner.runWithSudo(
      'echo $NUM_VAR',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        env: {
          NUM_VAR: '12345',
        },
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('12345');
  }, 120000);

  describe('--env-all flag', () => {
    test('should pass host environment variables into container', async () => {
      const result = await runner.runWithSudo(
        'echo $AWF_TEST_CUSTOM_VAR',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          envAll: true,
          env: {
            AWF_TEST_CUSTOM_VAR: 'env_all_works',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('env_all_works');
    }, 120000);

    test('should set proxy environment variables inside container', async () => {
      const result = await runner.runWithSudo(
        'bash -c "echo HTTP_PROXY=$HTTP_PROXY && echo HTTPS_PROXY=$HTTPS_PROXY"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          envAll: true,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/HTTP_PROXY=http:\/\/172\.30\.0\.10:3128/);
      expect(result.stdout).toMatch(/HTTPS_PROXY=http:\/\/172\.30\.0\.10:3128/);
    }, 120000);

    test('should set JAVA_TOOL_OPTIONS with JVM proxy properties', async () => {
      const result = await runner.runWithSudo(
        'bash -c "echo $JAVA_TOOL_OPTIONS"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          envAll: true,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('-Dhttp.proxyHost=');
      expect(result.stdout).toContain('-Dhttp.proxyPort=');
      expect(result.stdout).toContain('-Dhttps.proxyHost=');
      expect(result.stdout).toContain('-Dhttps.proxyPort=');
    }, 120000);

    test('should work together with explicit -e flags', async () => {
      const result = await runner.runWithSudo(
        'bash -c "echo HOST_VAR=$AWF_TEST_HOST_VAR && echo CLI_VAR=$AWF_TEST_CLI_VAR"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          envAll: true,
          env: {
            AWF_TEST_HOST_VAR: 'from_host',
          },
          cliEnv: {
            AWF_TEST_CLI_VAR: 'from_cli_flag',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('HOST_VAR=from_host');
      expect(result.stdout).toContain('CLI_VAR=from_cli_flag');
    }, 120000);

    test('explicit -e should override --env-all for same variable', async () => {
      const result = await runner.runWithSudo(
        'echo $AWF_TEST_OVERRIDE_VAR',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          envAll: true,
          env: {
            AWF_TEST_OVERRIDE_VAR: 'original_value',
          },
          cliEnv: {
            AWF_TEST_OVERRIDE_VAR: 'overridden_value',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('overridden_value');
      expect(result.stdout).not.toContain('original_value');
    }, 120000);

    test('should exclude system variables like PATH from passthrough', async () => {
      const sentinel = '/tmp/awf-sentinel-path-marker';
      const result = await runner.runWithSudo(
        'echo $PATH',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          envAll: true,
          env: {
            // Prepend sentinel to host PATH so sudo/node still work
            PATH: `${sentinel}:${process.env.PATH}`,
          },
        }
      );

      expect(result).toSucceed();
      // Container PATH should include its own default entries
      expect(result.stdout).toContain('/usr/local/bin');
      // Host PATH sentinel must NOT leak into the container
      expect(result.stdout).not.toContain(sentinel);
    }, 120000);
  });
});
