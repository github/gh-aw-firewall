/**
 * Exit Code Propagation Tests
 *
 * These tests verify that exit codes from commands running inside the firewall
 * are correctly propagated back to the calling process.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Exit Code Propagation', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Basic Exit Codes', () => {
    test('should propagate exit code 0 (success)', async () => {
      const result = await runner.run('exit 0', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(0);
      expect(result.stderr).toContain('Process exiting with code: 0');
    }, 120000);

    test('should propagate exit code 1 (general error)', async () => {
      const result = await runner.run('exit 1', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(1);
      expect(result.stderr).toContain('Process exiting with code: 1');
    }, 120000);

    test('should propagate exit code 2', async () => {
      const result = await runner.run('exit 2', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(2);
    }, 120000);

    test('should propagate exit code 42 (custom)', async () => {
      const result = await runner.run('exit 42', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(42);
    }, 120000);

    test('should propagate exit code 127 (command not found)', async () => {
      const result = await runner.run('nonexistent_command_xyz', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(127);
    }, 120000);

    test('should propagate exit code 255 (maximum)', async () => {
      const result = await runner.run('exit 255', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(255);
    }, 120000);
  });

  describe('Command Exit Codes', () => {
    test('should propagate exit code from successful command', async () => {
      const result = await runner.run('true', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(0);
    }, 120000);

    test('should propagate exit code from failing command', async () => {
      const result = await runner.run('false', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(1);
    }, 120000);

    test('should propagate exit code from test command (success)', async () => {
      const result = await runner.run('test 1 -eq 1', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(0);
    }, 120000);

    test('should propagate exit code from test command (failure)', async () => {
      const result = await runner.run('test 1 -eq 2', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(1);
    }, 120000);

    test('should propagate exit code from grep (found)', async () => {
      const result = await runner.run('echo "hello world" | grep hello', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(0);
    }, 120000);

    test('should propagate exit code from grep (not found)', async () => {
      const result = await runner.run('echo "hello world" | grep xyz', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(1);
    }, 120000);
  });

  describe('Pipeline Exit Codes', () => {
    test('should propagate exit code from last command in pipeline', async () => {
      const result = await runner.run('echo "test" | cat | exit 5', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(5);
    }, 120000);

    test('should propagate success from compound command', async () => {
      const result = await runner.run('echo "a" && echo "b" && exit 0', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(0);
    }, 120000);

    test('should propagate failure from compound command', async () => {
      const result = await runner.run('echo "a" && false && echo "c"', {
        allowDomains: ['github.com'],
        logLevel: 'debug',
        timeout: 60000,
      });

      expect(result).toExitWithCode(1);
    }, 120000);
  });
});
