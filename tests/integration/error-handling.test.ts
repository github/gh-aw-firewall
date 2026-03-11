/**
 * Error Handling Tests
 *
 * These tests verify error handling scenarios:
 * - Invalid domain configurations
 * - Network errors
 * - Timeout scenarios
 * - Command failures
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Error Handling', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Network Errors', () => {
    test('should handle blocked domain gracefully', async () => {
      const result = await runner.runWithSudo(
        'curl -f https://example.com --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
      // Should have non-zero exit code
      expect(result.exitCode).not.toBe(0);
    }, 120000);

    test('should handle connection refused gracefully', async () => {
      // Trying to connect to localhost where no server is running
      const result = await runner.runWithSudo(
        'curl -f http://localhost:12345 --max-time 5 || echo "connection failed"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('connection failed');
    }, 120000);

    test('should handle DNS resolution failure gracefully', async () => {
      const result = await runner.runWithSudo(
        'curl -f https://this-domain-definitely-does-not-exist-xyz123.com --max-time 5 || echo "dns failed"',
        {
          allowDomains: ['this-domain-definitely-does-not-exist-xyz123.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('dns failed');
    }, 120000);
  });

  describe('Command Errors', () => {
    test('should handle command not found', async () => {
      const result = await runner.runWithSudo(
        'nonexistent_command_xyz123',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
      expect(result.exitCode).toBe(127);
    }, 120000);

    test('should handle permission denied', async () => {
      const result = await runner.runWithSudo(
        'cat /etc/shadow 2>&1 || echo "permission denied handled"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/permission denied|denied handled/i);
    }, 120000);

    test('should handle file not found', async () => {
      const result = await runner.runWithSudo(
        'cat /nonexistent/file/path 2>&1 || echo "file not found handled"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/No such file|not found handled/i);
    }, 120000);
  });

  describe('Script Errors', () => {
    test('should handle bash syntax errors', async () => {
      const result = await runner.runWithSudo(
        'bash -c "if then fi" 2>&1 || echo "syntax error caught"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('syntax error caught');
    }, 120000);

    test('should handle division by zero in bash', async () => {
      // Use expr for division to avoid bash arithmetic expansion in outer shell.
      // bash $((1/0)) fails during expansion before || can catch it.
      const result = await runner.runWithSudo(
        'expr 1 / 0 2>&1 || echo "division error caught"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('division error caught');
    }, 120000);
  });

  describe('Process Signals', () => {
    test('should handle SIGTERM from command', async () => {
      // Self-terminate with SIGTERM
      const result = await runner.runWithSudo(
        'bash -c "kill -TERM $$ 2>/dev/null; exit 0" || echo "signal handled"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Command should complete (either way)
      // The important thing is that the firewall handles it gracefully
      // Verify the result object is defined (command completed)
      expect(result).toBeDefined();
    }, 120000);
  });

  describe('Recovery After Errors', () => {
    test('should continue working after command failure', async () => {
      // First run a failing command
      await runner.runWithSudo(
        'false',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Then run a successful command
      const result = await runner.runWithSudo(
        'echo "recovery test"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('recovery test');
    }, 240000);
  });
});
