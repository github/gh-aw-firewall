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
 * Note: In DinD mode, the custom seccomp profile is skipped (Docker's default
 * is used instead) because Docker reads seccomp profiles from the daemon's
 * filesystem before container start.
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

describe('DinD Config Delivery', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
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

  test('should detect DinD environment when DOCKER_HOST is tcp://', async () => {
    // Run AWF with DOCKER_HOST pointing to DinD - validates detection and
    // volume-based config delivery. The user command may fail (chroot
    // incompatibility) but detection and container startup should work.
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

    expect(result.stderr).toMatch(/DinD environment detected/i);
    expect(result.stderr).toMatch(/DinD mode: Creating config volumes/i);
  }, TEST_TIMEOUT);

  test('should start containers successfully in DinD environment', async () => {
    // Verify that containers start without bind mount errors (the original
    // DinD bug). The seccomp fix allows container creation to succeed.
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

    // Containers should start successfully (no bind mount or seccomp errors)
    expect(result.stderr).toMatch(/Containers started successfully/i);
    expect(result.stderr).not.toMatch(/Failed to start containers/i);
    expect(result.stderr).not.toMatch(/not a directory/i);
    expect(result.stderr).not.toMatch(/seccomp profile.*failed/i);
  }, TEST_TIMEOUT);

  test('should clean up DinD config volumes after execution', async () => {
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

    // Verify volume lifecycle: created and cleaned up
    expect(result.stderr).toMatch(/DinD mode: Creating config volumes/i);
    expect(result.stderr).toMatch(/DinD mode: Config volumes created and populated/i);
    expect(result.stderr).toMatch(/DinD mode: Removing config volumes/i);
    expect(result.stderr).toMatch(/DinD mode: Config volumes removed/i);
  }, TEST_TIMEOUT);

  test('should not detect DinD in native Docker environment', async () => {
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
    expect(result.stderr).not.toMatch(/DinD environment detected/i);
  }, 180000);
});
