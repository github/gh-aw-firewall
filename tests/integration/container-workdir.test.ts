/**
 * Container Working Directory Tests
 *
 * These tests verify the --container-workdir CLI option:
 * - Default working directory is user's home (chroot mode uses host $HOME)
 * - Custom working directory can be set via CLI
 * - Commands execute from the specified working directory
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    const result = await runner.run('pwd', {
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
    const result = await runner.run('pwd', {
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
    const result = await runner.run(
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
    const result = await runner.run('pwd', {
      allowDomains: ['github.com'],
      logLevel: 'debug',
      timeout: 60000,
      containerWorkDir: process.env.HOME || '/root',
    });

    expect(result).toSucceed();
    // The output should contain the home directory
    expect(result.stdout.trim()).toContain(process.env.HOME || '/root');
  }, 120000);

  test('should start in a working directory that no default mount exposes', async () => {
    // Mirrors how gh-aw engines (e.g. codex) are pointed at a checkout outside
    // the AWF workspace mount: the directory must exist inside the sandbox at
    // the same absolute path, otherwise the agent falls back to / and keeps
    // retrying `cd`. See github/gh-aw-firewall#8015.
    const externalWorkDir = fs.mkdtempSync(path.join(os.homedir(), 'awf-external-workdir-'));
    fs.writeFileSync(path.join(externalWorkDir, 'marker.txt'), 'marker\n');

    try {
      const result = await runner.run('bash -c "pwd && cat marker.txt"', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
        containerWorkDir: externalWorkDir,
      });

      expect(result).toSucceed();
      const cleanOutput = extractCommandOutput(result.stdout);
      expect(cleanOutput).toContain(externalWorkDir);
      expect(cleanOutput).toContain('marker');
    } finally {
      fs.rmSync(externalWorkDir, { recursive: true, force: true });
    }
  }, 120000);

  test('should allow relative path access from custom working directory', async () => {
    // Verify that relative paths work correctly from the custom workdir
    const result = await runner.run(
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
