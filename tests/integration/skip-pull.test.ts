/**
 * Skip Pull Flag Tests
 *
 * These tests verify the --skip-pull flag behavior:
 * - Success when images are pre-downloaded (uses --build-local first to ensure images exist)
 * - Error when images are not available locally
 * - Rejection of --skip-pull with --build-local (incompatible flags)
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Skip Pull Flag', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test('should succeed with --skip-pull when images are pre-downloaded', async () => {
    // First, ensure images exist locally by building them
    const buildResult = await runner.runWithSudo(
      'echo "images built"',
      {
        allowDomains: ['github.com'],
        buildLocal: true,
        logLevel: 'debug',
        timeout: 120000,
      }
    );
    expect(buildResult).toSucceed();

    // Now run with --skip-pull, which should use the locally available images
    const result = await runner.runWithSudo(
      'echo "skip-pull works"',
      {
        allowDomains: ['github.com'],
        skipPull: true,
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('skip-pull works');
  }, 240000);

  test('should fail with --skip-pull when images are not available locally', async () => {
    // Use a non-existent image tag so Docker cannot find it locally
    const result = await runner.runWithSudo(
      'echo "should not reach here"',
      {
        allowDomains: ['github.com'],
        skipPull: true,
        imageTag: 'nonexistent-tag-xyz-999',
        logLevel: 'debug',
        timeout: 60000,
      }
    );

    expect(result).toFail();
  }, 120000);

  test('should reject --skip-pull with --build-local', async () => {
    const result = await runner.runWithSudo(
      'echo "should not reach here"',
      {
        allowDomains: ['github.com'],
        skipPull: true,
        buildLocal: true,
        logLevel: 'debug',
        timeout: 30000,
      }
    );

    expect(result).toFail();
    expect(result.stderr).toContain('--skip-pull cannot be used with --build-local');
  }, 60000);
});
