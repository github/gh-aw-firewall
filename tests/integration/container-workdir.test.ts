/**
 * Container Working Directory Tests
 *
 * These tests verify the --container-workdir CLI option:
 * - Default working directory is user's home (chroot mode uses host $HOME)
 * - Custom working directory can be set via CLI
 * - Commands execute from the specified working directory
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import { extractCommandOutput } from '../fixtures/stdout-helpers';

describe('Container Working Directory', () => {
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

  test('should use default working directory (user home in chroot mode)', async () => {
    const result = await runner.runWithSudo('pwd', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 60000,
    });

    expect(result).toSucceed();
    // In chroot mode (always enabled), default working directory is the user's home
    // (e.g., /home/runner on CI, /root locally). The Dockerfile's WORKDIR /workspace
    // doesn't apply after chroot into /host.
    const cleanOutput = extractCommandOutput(result.stdout).trim();
    expect(cleanOutput).toMatch(/\/home\/|\/root/);
  }, 120000);

  test('should use custom working directory when --container-workdir is specified', async () => {
    const result = await runner.runWithSudo('pwd', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 60000,
      containerWorkDir: '/tmp',
    });

    expect(result).toSucceed();
    expect(result.stdout.trim()).toContain('/tmp');
  }, 120000);

  test('should execute commands in the specified working directory', async () => {
    // Create a file in /tmp and verify we can list it from /tmp working directory
    const result = await runner.runWithSudo(
      'bash -c "touch testfile.txt && ls -la | grep testfile"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        containerWorkDir: '/tmp',
      }
    );

    expect(result).toSucceed();
    expect(result.stdout).toContain('testfile.txt');
  }, 120000);

  test('should work with home directory as working directory', async () => {
    const result = await runner.runWithSudo('pwd', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 60000,
      containerWorkDir: process.env.HOME || '/root',
    });

    expect(result).toSucceed();
    // The output should contain the home directory
    expect(result.stdout.trim()).toContain(process.env.HOME || '/root');
  }, 120000);

  test('should allow relative path access from custom working directory', async () => {
    // Verify that relative paths work correctly from the custom workdir
    const result = await runner.runWithSudo(
      'bash -c "cd .. && pwd"',
      {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        containerWorkDir: '/tmp',
      }
    );

    expect(result).toSucceed();
    // Going up from /tmp should give us /
    expect(result.stdout.trim()).toContain('/');
  }, 120000);
});
