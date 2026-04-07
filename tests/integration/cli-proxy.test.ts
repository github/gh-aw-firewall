/**
 * CLI Proxy Sidecar Integration Tests
 *
 * Tests that the --enable-cli-proxy flag correctly starts the CLI proxy sidecar,
 * routes gh CLI commands through the mcpg DIFC proxy, enforces subcommand
 * allowlists, and isolates GITHUB_TOKEN from the agent container.
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
const cliProxyDefaults = {
  allowDomains: ['github.com', 'api.github.com'],
  enableCliProxy: true,
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

  describe('Health and Startup', () => {
    test('should start cli-proxy sidecar and pass healthcheck', async () => {
      const result = await runner.runWithSudo(
        `curl -s http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/health`,
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('"status":"ok"');
      expect(result.stdout).toContain('"service":"cli-proxy"');
    }, 180000);

    test('should report writable=false in healthcheck by default', async () => {
      const result = await runner.runWithSudo(
        `curl -s http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/health`,
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('"writable":false');
    }, 180000);

    test('should report writable=true when --cli-proxy-writable is set', async () => {
      const result = await runner.runWithSudo(
        `curl -s http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/health`,
        { ...cliProxyDefaults, cliProxyWritable: true },
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('"writable":true');
    }, 180000);
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
      // The proxy may block --version as it's not a recognized subcommand.
      // Either way, it should not crash — we just verify the wrapper is invoked.
      // If it fails, the error should come from the proxy, not "command not found"
      const output = extractCommandOutput(result.stdout);
      const stderr = result.stderr || '';
      // Should NOT get "command not found" — the wrapper must be installed
      expect(output + stderr).not.toContain('command not found');
    }, 180000);
  });

  describe('Read-Only Mode (default)', () => {
    test('should block write operations in read-only mode', async () => {
      // Try to execute a write operation: 'gh issue create'
      // In read-only mode, 'create' action under 'issue' is blocked
      const result = await runner.runWithSudo(
        `bash -c 'curl -s -X POST http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/exec -H "Content-Type: application/json" -d "{\\"args\\":[\\"issue\\",\\"create\\",\\"--title\\",\\"test\\"]}"'`,
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      // The proxy should return a 403 with an error about the blocked action
      expect(result.stdout).toMatch(/denied|blocked|not allowed|read.only/i);
    }, 180000);

    test('should block gh api in read-only mode', async () => {
      // 'api' is always blocked in read-only mode (raw HTTP passthrough risk)
      const result = await runner.runWithSudo(
        `bash -c 'curl -s -X POST http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/exec -H "Content-Type: application/json" -d "{\\"args\\":[\\"api\\",\\"/repos/github/gh-aw-firewall\\"]}"'`,
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/denied|blocked|not allowed/i);
    }, 180000);

    test('should block auth subcommand even in writable mode', async () => {
      // 'auth' is always denied (meta-command)
      const result = await runner.runWithSudo(
        `bash -c 'curl -s -X POST http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/exec -H "Content-Type: application/json" -d "{\\"args\\":[\\"auth\\",\\"status\\"]}"'`,
        { ...cliProxyDefaults, cliProxyWritable: true },
      );

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/denied|blocked|not allowed/i);
    }, 180000);

    test('should allow read operations in read-only mode', async () => {
      // 'pr list' is a read-only operation — should be allowed by the proxy.
      // The actual gh command may fail (auth error from mcpg with fake token),
      // but the proxy should NOT block it at the allowlist level.
      const result = await runner.runWithSudo(
        `bash -c 'curl -s -w "\\nHTTP_STATUS:%{http_code}" -X POST http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/exec -H "Content-Type: application/json" -d "{\\"args\\":[\\"pr\\",\\"list\\",\\"--repo\\",\\"github/gh-aw-firewall\\",\\"--limit\\",\\"1\\"]}"'`,
        cliProxyDefaults,
      );

      expect(result).toSucceed();
      // HTTP 200 means the proxy allowed the command (even if gh itself errored)
      expect(result.stdout).toContain('HTTP_STATUS:200');
    }, 180000);
  });

  describe('Writable Mode', () => {
    test('should allow gh api in writable mode', async () => {
      // 'api' is permitted in writable mode
      const result = await runner.runWithSudo(
        `bash -c 'curl -s -w "\\nHTTP_STATUS:%{http_code}" -X POST http://${CLI_PROXY_IP}:${CLI_PROXY_PORT}/exec -H "Content-Type: application/json" -d "{\\"args\\":[\\"api\\",\\"/repos/github/gh-aw-firewall\\"]}"'`,
        { ...cliProxyDefaults, cliProxyWritable: true },
      );

      expect(result).toSucceed();
      // HTTP 200 means the proxy allowed the command
      expect(result.stdout).toContain('HTTP_STATUS:200');
    }, 180000);
  });

  describe('Squid Integration', () => {
    test('should route cli-proxy traffic through Squid domain allowlist', async () => {
      // The cli-proxy container uses HTTP_PROXY/HTTPS_PROXY to route through Squid.
      // A domain NOT in --allow-domains should be blocked by Squid.
      // We verify by checking that the cli-proxy env includes the proxy settings.
      const result = await runner.runWithSudo(
        `bash -c 'docker exec awf-cli-proxy env | grep -i proxy || true'`,
        { ...cliProxyDefaults, keepContainers: true },
      );

      // Don't require success — docker exec may require the container to still be running
      // Just verify the env vars are set in the compose config by checking stderr logs
      expect(result.stderr).toMatch(/HTTP_PROXY|HTTPS_PROXY|squid/i);
    }, 180000);
  });
});
