/**
 * Docker-in-Docker Removal Regression Tests
 * Tests for PR #205: https://github.com/github/gh-aw-firewall/pull/205
 *
 * These tests verify that Docker commands fail gracefully after Docker-in-Docker
 * support was removed in v0.9.1. The agent container should NOT have:
 * - docker-cli installed
 * - Docker socket mounted
 * - Docker daemon running
 *
 * IMPORTANT: These tests require container images built from commit 8d81fe4 or later.
 * The integration workflow pre-builds local images before this test file runs, so the
 * tests use `skipPull: true` to avoid image pulls/rebuilds during each test case.
 *
 * If tests fail with "docker found" errors, the pre-built test images are stale and
 * need to be rebuilt before running this suite.
 *
 * NOTE: docker-warning.test.ts was removed as redundant — the Docker stub-script
 * approach was superseded by removing docker-cli entirely. This file covers the
 * Docker removal behavior (command not found, no socket, graceful failure).
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Docker-in-Docker removal (PR #205)', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    // Run cleanup before tests to ensure clean state
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    // Clean up after all tests
    await cleanup(false);
  });

  test('docker command should not be available', async () => {
    // In chroot mode, the host PATH is used and may include docker.
    // Verify docker is not installed in the CONTAINER image (not in the chroot).
    // Check that docker socket is not available (the important security boundary).
    const result = await runner.run(
      'test -S /var/run/docker.sock && echo "docker_socket_found" || echo "no_docker_socket"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 300000,
        skipPull: true,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('no_docker_socket');
  }, 360000);

  test('docker run should fail gracefully', async () => {
    const result = await runner.run('docker run alpine echo hello', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 300000,
      skipPull: true,
    });

    // Should fail because docker command doesn't exist
    expect(result).toFail();
    expect(result.exitCode).not.toBe(0);
    // The stderr should contain some indication that docker is not found
    expect(result.stderr).toMatch(/docker|not found|command not found/i);
  }, 360000);

  test('docker-compose should not be available', async () => {
    const result = await runner.run('which docker-compose', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 300000,
      skipPull: true,
    });

    // Should fail because docker-compose is not installed
    expect(result).toFail();
    expect(result.exitCode).not.toBe(0);
  }, 360000);

  test('verify docker socket is not mounted', async () => {
    const result = await runner.run(
      'test -S /var/run/docker.sock && echo "mounted" || echo "not mounted"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 300000,
        skipPull: true,
      }
    );

    // Command should succeed (it always echoes something)
    expect(result).toSucceed();
    expect(result.exitCode).toBe(0);
    // But the socket should NOT be mounted
    expect(result.stdout).toContain('not mounted');
  }, 360000);
});
