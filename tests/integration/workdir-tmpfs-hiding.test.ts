/**
 * WorkDir tmpfs Hiding Integration Tests
 *
 * These tests verify that AWF's tmpfs overlay on the workDir prevents the agent
 * from reading docker-compose.yml, which contains plaintext tokens (GITHUB_TOKEN,
 * ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, etc.) passed via environment variables.
 *
 * Security Threat Model:
 * - docker-compose.yml in the workDir contains every env var passed to the container
 * - Without tmpfs overlay, an agent could read secrets via:
 *   cat /tmp/awf-{ts}/docker-compose.yml (normal path)
 *   cat /host/tmp/awf-{ts}/docker-compose.yml (chroot path)
 *
 * Security Mitigation:
 * - tmpfs is mounted over both workDir and /host/workDir
 * - This makes the directory appear empty to the agent
 * - Subdirectory volume mounts (agent-logs, squid-logs) are unaffected
 *
 * Related: PR #718, Issue #620, Issue #759
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('WorkDir tmpfs Hiding', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Normal Mode', () => {
    test('Test 1: docker-compose.yml is not readable in workDir', async () => {
      // Run AWF with a command that tries to find and read docker-compose.yml
      // The workDir is /tmp/awf-<timestamp>, so we glob for it
      const result = await runner.runWithSudo(
        'sh -c \'for d in /tmp/awf-*/; do if [ -f "$d/docker-compose.yml" ]; then cat "$d/docker-compose.yml"; echo "FOUND_COMPOSE"; fi; done\'',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // The tmpfs overlay makes the workDir appear empty,
      // so docker-compose.yml should not be found
      const output = result.stdout.trim();
      expect(output).not.toContain('FOUND_COMPOSE');
      expect(output).not.toContain('services:');
      expect(output).not.toContain('GITHUB_TOKEN');
      expect(output).not.toContain('ANTHROPIC_API_KEY');
    }, 120000);

    test('Test 2: workDir appears empty to the agent', async () => {
      // List contents of any awf workdir - tmpfs should make it appear empty
      const result = await runner.runWithSudo(
        'sh -c \'for d in /tmp/awf-*/; do if [ -d "$d" ]; then echo "DIR:$d"; ls -la "$d" 2>&1; fi; done\'',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // The directory may exist (tmpfs is mounted) but should not contain
      // docker-compose.yml or squid.conf
      const output = result.stdout;
      expect(output).not.toContain('docker-compose.yml');
      expect(output).not.toContain('squid.conf');
    }, 120000);

    test('Test 3: sensitive env vars are not leaked via workDir files', async () => {
      // Pass a known secret via env and verify it cannot be found in workDir files
      const result = await runner.runWithSudo(
        'sh -c \'find /tmp/awf-* -type f 2>/dev/null | while read f; do cat "$f" 2>/dev/null; done | grep -c "SECRET_CANARY_VALUE" || echo "0"\'',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          cliEnv: { TEST_SECRET: 'SECRET_CANARY_VALUE' },
          envAll: true,
        }
      );

      // The canary value should not appear in any readable file
      const output = result.stdout.trim();
      // grep -c returns "0" when no matches found
      expect(output).toMatch(/^0$/m);
    }, 120000);
  });

  describe('Chroot Mode', () => {
    test('Test 4: docker-compose.yml is not readable at /host workDir path', async () => {
      // In chroot mode, the host filesystem is at /host
      // Try to read docker-compose.yml via the /host prefix
      const result = await runner.runWithSudo(
        'sh -c \'for d in /host/tmp/awf-*/; do if [ -f "$d/docker-compose.yml" ]; then cat "$d/docker-compose.yml"; echo "FOUND_COMPOSE"; fi; done\'',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      const output = result.stdout.trim();
      expect(output).not.toContain('FOUND_COMPOSE');
      expect(output).not.toContain('services:');
      expect(output).not.toContain('GITHUB_TOKEN');
    }, 120000);

    test('Test 5: /host workDir also appears empty', async () => {
      const result = await runner.runWithSudo(
        'sh -c \'for d in /host/tmp/awf-*/; do if [ -d "$d" ]; then echo "DIR:$d"; ls -la "$d" 2>&1; fi; done\'',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      const output = result.stdout;
      expect(output).not.toContain('docker-compose.yml');
      expect(output).not.toContain('squid.conf');
    }, 120000);
  });

  describe('Security Verification', () => {
    test('Test 6: grep for secrets in workDir finds nothing', async () => {
      // Simulate an attack: search for common secret patterns in any awf workDir
      const result = await runner.runWithSudo(
        'sh -c \'grep -r "GITHUB_TOKEN\\|ANTHROPIC_API_KEY\\|COPILOT_GITHUB_TOKEN\\|_authToken" /tmp/awf-*/ 2>&1 || true\' | grep -v "^\\[" | head -5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          cliEnv: { GITHUB_TOKEN: 'ghp_test_token_12345' },
          envAll: true,
        }
      );

      // Should not find any secrets
      const output = result.stdout.trim();
      expect(output).not.toContain('ghp_test_token_12345');
      expect(output).not.toContain('GITHUB_TOKEN');
    }, 120000);

    test('Test 7: debug logs confirm tmpfs overlay is configured', async () => {
      const result = await runner.runWithSudo(
        'echo "test"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Debug logs should show tmpfs configuration
      expect(result.stderr).toMatch(/tmpfs/i);
    }, 120000);
  });
});
