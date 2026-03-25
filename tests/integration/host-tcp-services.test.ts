/**
 * Host TCP Service Ports Tests
 *
 * These tests verify the --allow-host-service-ports flag, which allows
 * TCP connections to the host gateway on ports that are normally blocked
 * as "dangerous" (e.g., database ports like 5432, 6379, 3306).
 *
 * This is designed for GitHub Actions `services:` containers that publish
 * to the host via port mapping. The agent can reach these services on the
 * host but still cannot reach databases on the internet.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import * as net from 'net';

/**
 * Start a TCP echo server on a given port.
 * Returns a function to close the server.
 */
function startTcpEchoServer(port: number): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`ECHO:${data.toString()}`);
        socket.end();
      });
      socket.on('error', () => {
        // Ignore client errors
      });
    });

    server.on('error', reject);

    server.listen(port, '0.0.0.0', () => {
      resolve({
        close: () => new Promise<void>((res, rej) => {
          server.close((err) => err ? rej(err) : res());
        }),
      });
    });
  });
}

describe('Host TCP Service Ports', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should auto-enable host access when --allow-host-service-ports is used', async () => {
    const result = await runner.runWithSudo('echo "test"', {
      allowDomains: ['github.com'],
      allowHostServicePorts: '5432',
      logLevel: 'debug',
      timeout: 60000,
    });

    expect(result).toSucceed();
    expect(result.stderr).toContain('automatically enabling host access');
    expect(result.stderr).toContain('Host service ports allowed (host gateway only): 5432');
  }, 120000);

  test('should allow TCP connection to host service on a dangerous port (Redis 6379)', async () => {
    // Start a TCP echo server on a dangerous port (Redis 6379, in DANGEROUS_PORTS list)
    const TEST_PORT = 6379;
    let server: { close: () => Promise<void> };
    try {
      server = await startTcpEchoServer(TEST_PORT);
    } catch {
      // If we can't bind to 6379 (e.g., already in use), skip
      console.log(`Skipping test: could not bind to port ${TEST_PORT}`);
      return;
    }

    try {
      // Run a command inside AWF that connects to host.docker.internal on the test port
      const result = await runner.runWithSudo(
        `bash -c 'echo "HELLO" | nc -w 5 host.docker.internal ${TEST_PORT}'`,
        {
          allowDomains: ['github.com'],
          allowHostServicePorts: String(TEST_PORT),
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('ECHO:HELLO');
    } finally {
      await server.close();
    }
  }, 120000);

  test('should allow TCP connection to actual dangerous port (5432) on host', async () => {
    // Start a TCP echo server on PostgreSQL port 5432
    // This requires the test to run with sufficient privileges
    const TEST_PORT = 5432;
    let server: { close: () => Promise<void> } | null = null;

    try {
      server = await startTcpEchoServer(TEST_PORT);
    } catch {
      // If we can't bind to 5432 (e.g., already in use or no privileges), skip
      console.log(`Skipping test: could not bind to port ${TEST_PORT}`);
      return;
    }

    try {
      const result = await runner.runWithSudo(
        `bash -c 'echo "PGTEST" | nc -w 5 host.docker.internal ${TEST_PORT}'`,
        {
          allowDomains: ['github.com'],
          allowHostServicePorts: String(TEST_PORT),
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('ECHO:PGTEST');
    } finally {
      if (server) await server.close();
    }
  }, 120000);

  test('should block dangerous port to non-host destinations (internet)', async () => {
    // Even with --allow-host-service-ports 5432, traffic to external IPs
    // on port 5432 should still be blocked
    const result = await runner.runWithSudo(
      'bash -c \'curl -s --connect-timeout 5 http://example.com:5432/ 2>&1 || echo "BLOCKED"\'',
      {
        allowDomains: ['example.com'],
        allowHostServicePorts: '5432',
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    // The connection to example.com:5432 should fail because the port is only
    // allowed to the host gateway, not to internet destinations
    expect(result.stdout).toContain('BLOCKED');
  }, 120000);

  test('should allow multiple service ports', async () => {
    const result = await runner.runWithSudo('echo "test"', {
      allowDomains: ['github.com'],
      allowHostServicePorts: '5432,6379,3306',
      logLevel: 'debug',
      timeout: 60000,
    });

    expect(result).toSucceed();
    expect(result.stderr).toContain('Host service ports allowed (host gateway only): 5432,6379,3306');
    // Should show iptables rules for each port
    expect(result.stderr).toContain('Allow host service port 5432');
    expect(result.stderr).toContain('Allow host service port 6379');
    expect(result.stderr).toContain('Allow host service port 3306');
  }, 120000);
});
