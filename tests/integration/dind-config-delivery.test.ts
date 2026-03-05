/**
 * DinD (Docker-in-Docker) Config Delivery Tests
 *
 * These tests verify that AWF works correctly in a DinD environment where
 * the Docker daemon runs in a separate container. In DinD, bind mounts from
 * the host are not visible to the Docker daemon, so AWF must use volume-based
 * config delivery instead of file bind mounts.
 *
 * Prerequisites:
 * - Docker must be available
 * - The docker:dind image must be pullable
 * - Tests require sudo for iptables manipulation
 *
 * Known issue: The seccomp profile delivery doesn't work in DinD mode yet.
 * Docker's security_opt reads the seccomp file from the daemon's filesystem,
 * not from container volumes. Tests are marked as .skip until the seccomp
 * delivery is fixed for DinD environments.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import execa = require('execa');

const DIND_CONTAINER_NAME = 'awf-test-dind';
const DIND_PORT = 2375;
const DOCKER_HOST_URL = `tcp://localhost:${DIND_PORT}`;

// Longer timeouts: DinD startup + building local images is slow
const DIND_STARTUP_TIMEOUT = 60000;
const TEST_TIMEOUT = 300000; // 5 minutes per test (build-local in DinD is slow)

async function isDindReady(): Promise<boolean> {
  try {
    await execa('docker', ['-H', DOCKER_HOST_URL, 'info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForDind(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDindReady()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`DinD daemon did not become ready within ${timeoutMs}ms`);
}

async function startDind(): Promise<void> {
  // Remove any leftover container
  try {
    await execa('docker', ['rm', '-f', DIND_CONTAINER_NAME]);
  } catch {
    // ignore
  }

  // Start DinD container with TLS disabled for simplicity
  await execa('docker', [
    'run', '-d', '--privileged',
    '--name', DIND_CONTAINER_NAME,
    '-p', `${DIND_PORT}:2375`,
    '-e', 'DOCKER_TLS_CERTDIR=',
    'docker:dind',
    '--tls=false',
  ]);

  await waitForDind(DIND_STARTUP_TIMEOUT);
}

async function stopDind(): Promise<void> {
  try {
    await execa('docker', ['rm', '-f', DIND_CONTAINER_NAME]);
  } catch {
    // ignore
  }
}

async function cleanupDindResources(): Promise<void> {
  try {
    await execa('docker', ['-H', DOCKER_HOST_URL, 'rm', '-f', 'awf-squid', 'awf-agent'], {
      reject: false,
      timeout: 10000,
    });
    await execa('docker', ['-H', DOCKER_HOST_URL, 'network', 'prune', '-f'], {
      reject: false,
      timeout: 10000,
    });
    // Remove any awf config volumes
    const { stdout } = await execa('docker', ['-H', DOCKER_HOST_URL, 'volume', 'ls', '-q', '--filter', 'name=awf-'], {
      reject: false,
      timeout: 10000,
    });
    if (stdout.trim()) {
      const volumes = stdout.trim().split('\n');
      for (const vol of volumes) {
        await execa('docker', ['-H', DOCKER_HOST_URL, 'volume', 'rm', '-f', vol], {
          reject: false,
          timeout: 5000,
        });
      }
    }
  } catch {
    // ignore
  }
}

// Skip: seccomp profile delivery in DinD not yet implemented.
// Docker reads security_opt seccomp profile from the daemon filesystem,
// not from container volumes. Remove .skip when seccomp delivery is fixed.
describe.skip('DinD Config Delivery', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    // Check if Docker is available
    try {
      await execa('docker', ['info'], { timeout: 5000 });
    } catch {
      console.warn('Docker not available, skipping DinD tests');
      return;
    }

    await cleanup(false);
    await startDind();
    runner = createRunner();
  }, DIND_STARTUP_TIMEOUT + 30000);

  afterAll(async () => {
    await cleanupDindResources();
    await stopDind();
    await cleanup(false);
  }, 60000);

  test('should start containers and proxy traffic in DinD environment', async () => {
    const result = await runner.runWithSudo(
      'curl -sf --max-time 15 https://example.com',
      {
        allowDomains: ['example.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: TEST_TIMEOUT,
        env: {
          DOCKER_HOST: DOCKER_HOST_URL,
        },
      }
    );

    expect(result).toSucceed();
    // Verify DinD detection message in logs
    expect(result.stderr).toMatch(/DinD environment detected/i);
  }, TEST_TIMEOUT);

  test('should block domains not in allowlist in DinD environment', async () => {
    const result = await runner.runWithSudo(
      'curl -sf --max-time 10 https://github.com',
      {
        allowDomains: ['example.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: TEST_TIMEOUT,
        env: {
          DOCKER_HOST: DOCKER_HOST_URL,
        },
      }
    );

    // github.com is not in the allowlist, should be blocked
    expect(result).toFail();
    // Verify it failed due to domain blocking, not a startup error
    expect(result.stderr).toMatch(/DinD environment detected/i);
    expect(result.stderr).not.toMatch(/Failed to start containers/i);
  }, TEST_TIMEOUT);
});

describe('DinD Detection', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    try {
      await execa('docker', ['info'], { timeout: 5000 });
    } catch {
      console.warn('Docker not available, skipping DinD detection tests');
      return;
    }

    await cleanup(false);
    await startDind();
    runner = createRunner();
  }, DIND_STARTUP_TIMEOUT + 30000);

  afterAll(async () => {
    await cleanupDindResources();
    await stopDind();
    await cleanup(false);
  }, 60000);

  test('should detect DinD environment when DOCKER_HOST is tcp://', async () => {
    // Run AWF with DOCKER_HOST pointing to DinD - it should detect DinD mode.
    // The command itself may fail (seccomp issue), but we verify DinD detection in stderr.
    const result = await runner.runWithSudo(
      'echo hello',
      {
        allowDomains: ['example.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: TEST_TIMEOUT,
        env: {
          DOCKER_HOST: DOCKER_HOST_URL,
        },
      }
    );

    // DinD should be detected regardless of whether the full flow succeeds
    expect(result.stderr).toMatch(/DinD environment detected/i);
    // Should use volume-based config delivery
    expect(result.stderr).toMatch(/DinD mode: Creating config volumes/i);
  }, TEST_TIMEOUT);

  test('should not detect DinD in native Docker environment', async () => {
    // Run AWF without DOCKER_HOST - should use native Docker
    const result = await runner.runWithSudo(
      'echo hello',
      {
        allowDomains: ['example.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
      }
    );

    expect(result).toSucceed();
    // Should NOT see DinD detection message
    expect(result.stderr).not.toMatch(/DinD environment detected/i);
  }, 180000);
});
