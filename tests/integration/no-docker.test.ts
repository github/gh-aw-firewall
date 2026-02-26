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
 * If using registry images (ghcr.io/github/gh-aw-firewall), ensure they have been
 * rebuilt after PR #205 was merged. Otherwise, use `buildLocal: true` in test options
 * to build fresh images from the current codebase.
 *
 * Known Issue: Building locally may fail due to NodeSource repository issues.
 * If tests fail with "docker found" errors, the images need to be rebuilt and published.
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
    const result = await runner.runWithSudo('which docker', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 30000,
    });

    // Should fail because docker-cli is not installed
    expect(result).toFail();
    expect(result.exitCode).not.toBe(0);
  }, 120000);

  test('docker run should fail gracefully', async () => {
    const result = await runner.runWithSudo('docker run alpine echo hello', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 30000,
    });

    // Should fail because docker command doesn't exist
    expect(result).toFail();
    expect(result.exitCode).not.toBe(0);
    // The stderr should contain some indication that docker is not found
    expect(result.stderr).toMatch(/docker|not found|command not found/i);
  }, 120000);

  test('docker-compose should not be available', async () => {
    const result = await runner.runWithSudo('which docker-compose', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 30000,
    });

    // Should fail because docker-compose is not installed
    expect(result).toFail();
    expect(result.exitCode).not.toBe(0);
  }, 120000);

  test('verify docker socket is not mounted', async () => {
    const result = await runner.runWithSudo(
      'test -S /var/run/docker.sock && echo "mounted" || echo "not mounted"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 30000,
      }
    );

    // Command should succeed (it always echoes something)
    expect(result).toSucceed();
    expect(result.exitCode).toBe(0);
    // But the socket should NOT be mounted
    expect(result.stdout).toContain('not mounted');
  }, 120000);
});
