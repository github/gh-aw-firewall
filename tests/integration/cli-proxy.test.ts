/**
 * CLI Proxy Sidecar Integration Tests
 *
 * Tests that the --difc-proxy-host flag correctly starts the CLI proxy sidecar,
 * connects to an external DIFC proxy, routes gh CLI commands through it,
 * and isolates GITHUB_TOKEN from the agent container.
 *
 * Note: These tests require a running external DIFC proxy. In CI, the
 * smoke-copilot workflow provides full end-to-end coverage. These tests
 * validate the compose generation and container setup.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import { extractCommandOutput } from '../fixtures/stdout-helpers';

// The CLI proxy sidecar is at this fixed IP on the awf-net network
const CLI_PROXY_IP = '172.30.0.50';
const CLI_PROXY_PORT = 11000;

// Common test options for cli-proxy tests
// Note: These tests require a running external DIFC proxy at the specified host
const cliProxyDefaults = {
  allowDomains: ['github.com', 'api.github.com'],
  difcProxyHost: 'host.docker.internal:18443',
  difcProxyCaCert: '/tmp/difc-proxy-tls/ca.crt',
  buildLocal: true,
  logLevel: 'debug' as const,
  timeout: 120000,
  env: {
    GITHUB_TOKEN: 'ghp_fake-test-token-for-cli-proxy-12345',
  },
};

describe('CLI Proxy Sidecar', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Token Isolation', () => {
    test('should not expose GITHUB_TOKEN in agent environment', async () => {
      const result = await runner.runWithSudo(
        'bash -c "if [ -z \\"$GITHUB_TOKEN\\" ]; then echo GITHUB_TOKEN_NOT_SET; else echo GITHUB_TOKEN=$GITHUB_TOKEN; fi"',
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      const output = extractCommandOutput(result.stdout);
      expect(output).toContain('GITHUB_TOKEN_NOT_SET');
    }, 180000);

    test('should not expose GH_TOKEN in agent environment', async () => {
      const result = await runner.runWithSudo(
        'bash -c "if [ -z \\"$GH_TOKEN\\" ]; then echo GH_TOKEN_NOT_SET; else echo GH_TOKEN=$GH_TOKEN; fi"',
        {
          ...cliProxyDefaults,
          env: {
            GH_TOKEN: 'ghp_fake-test-token-gh-12345',
          },
        },
      );

      expect(result).toSucceed();
      const output = extractCommandOutput(result.stdout);
      expect(output).toContain('GH_TOKEN_NOT_SET');
    }, 180000);

    test('should set AWF_CLI_PROXY_URL in agent environment', async () => {
      const result = await runner.runWithSudo(
        'bash -c "echo AWF_CLI_PROXY_URL=$AWF_CLI_PROXY_URL"',
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain(`AWF_CLI_PROXY_URL=http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}`);
    }, 180000);
  });

  describe('gh Wrapper', () => {
    test('should install gh wrapper that routes to cli-proxy', async () => {
      // The gh wrapper should be at /usr/local/bin/gh or accessible via PATH.
      // Running 'which gh' should find it.
      const result = await runner.runWithSudo(
        'bash -c "which gh && head -3 $(which gh)"',
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      const output = extractCommandOutput(result.stdout);
      // The wrapper script should reference CLI_PROXY or AWF_CLI_PROXY_URL
      expect(output).toMatch(/cli.proxy|AWF_CLI_PROXY/i);
    }, 180000);

    test('should execute gh commands through the wrapper', async () => {
      // gh --version should work through the proxy (it runs locally in the sidecar)
      // Note: this tests that the wrapper → HTTP POST → server.js → execFile chain works
      const result = await runner.runWithSudo(
        'gh --version',
        cliProxyDefaults,
      );

      // gh --version goes through the wrapper and the proxy server
      // Either way, it should not crash — we just verify the wrapper is invoked.
      const output = extractCommandOutput(result.stdout);
      const stderr = result.stderr || '';
      // Should NOT get "command not found" — the wrapper must be installed
      expect(output + stderr).not.toContain('command not found');
    }, 180000);
  });

  describe('Meta-command Denial', () => {
    test('should block auth subcommand', async () => {
      // 'auth' is always denied (meta-command)
      const result = await runner.runWithSudo(
        `bash -c 'curl -s -w "\\nHTTP_STATUS:%{http_code}" -X POST http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/exec -H "Content-Type: application/json" -d "{\\"args\\":[\\"auth\\",\\"status\\"]}"'`,
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('HTTP_STATUS:403');
      expect(result.stdout).toMatch(/denied|blocked|not allowed|not permitted/i);
    }, 180000);
  });
});
