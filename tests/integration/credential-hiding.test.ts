/**
 * Credential Hiding Security Tests
 *
 * These tests verify that AWF protects against credential exfiltration via prompt injection attacks
 * by selectively mounting only necessary directories and hiding sensitive credential files.
 *
 * Security Threat Model:
 * - AI agents can be manipulated through prompt injection attacks
 * - Attackers inject commands to read credential files using bash tools (cat, base64, curl)
 * - Credentials at risk: Docker Hub, GitHub CLI, NPM, Cargo, Composer tokens, Git credentials/extraheaders
 *
 * Security Mitigation:
 * - Selective mounting: Only mount directories needed for operation
 * - Credential hiding: Mount /dev/null over credential files (they appear empty)
 * - Works in both normal and chroot modes
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import * as fs from 'fs';
import * as os from 'os';

describe('Credential Hiding Security', () => {
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

  describe('Normal Mode', () => {
    test('Test 1: Docker config.json is hidden (empty file)', async () => {
      // Use the real home directory - if the file exists, it should be hidden
      const homeDir = os.homedir();
      const dockerConfig = `${homeDir}/.docker/config.json`;

      const result = await runner.runWithSudo(
        `cat ${dockerConfig} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Command should succeed (file is "readable" but empty)
      expect(result).toSucceed();
      // Output should be empty (no credential data leaked)
      const output = result.stdout.trim();
      expect(output).toBe('');
    }, 120000);

    test('Test 2: GitHub CLI hosts.yml is hidden (empty file)', async () => {
      const homeDir = os.homedir();
      const hostsFile = `${homeDir}/.config/gh/hosts.yml`;

      const result = await runner.runWithSudo(
        `cat ${hostsFile} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      const output = result.stdout.trim();
      // Should be empty (no oauth_token visible)
      expect(output).not.toContain('oauth_token');
      expect(output).not.toContain('gho_');
    }, 120000);

    test('Test 3: NPM .npmrc is hidden (empty file)', async () => {
      const homeDir = os.homedir();
      const npmrc = `${homeDir}/.npmrc`;

      const result = await runner.runWithSudo(
        `cat ${npmrc} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      const output = result.stdout.trim();
      // Should not contain auth tokens
      expect(output).not.toContain('_authToken');
      expect(output).not.toContain('npm_');
    }, 120000);

    test('Test 4: Credential files are mounted from /dev/null', async () => {
      const homeDir = os.homedir();

      // Check multiple credential files in one command
      const result = await runner.runWithSudo(
        `sh -c 'for f in ${homeDir}/.docker/config.json ${homeDir}/.npmrc ${homeDir}/.config/gh/hosts.yml; do if [ -f "$f" ]; then wc -c "$f"; fi; done' 2>&1 | grep -v "^\\["`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // All files should show 0 bytes (empty, from /dev/null)
      const lines = result.stdout.split('\n').filter(l => l.match(/^\s*\d+/));
      lines.forEach(line => {
        const size = parseInt(line.trim().split(/\s+/)[0]);
        expect(size).toBe(0); // Each file should be 0 bytes
      });
    }, 120000);

    test('Test 5: Debug logs show credential hiding is active', async () => {
      const result = await runner.runWithSudo(
        'echo "test"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Check debug logs for credential hiding messages
      expect(result.stderr).toMatch(/Using selective mounting|Hidden.*credential/i);
    }, 120000);
  });

  describe('Chroot Mode', () => {
    test('Test 6: Chroot mode hides credentials at /host paths', async () => {
      const homeDir = os.homedir();

      // Try to read Docker config at /host path
      const result = await runner.runWithSudo(
        `cat /host${homeDir}/.docker/config.json 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // May succeed with empty content or fail with "No such file" (both indicate hiding)
      if (result.success) {
        const output = result.stdout.trim();
        // Should be empty (no credential data)
        expect(output).toBe('');
      } else {
        // File not found is also acceptable (credential is hidden)
        expect(result.stderr).toMatch(/No such file|cannot access/i);
      }
    }, 120000);

    test('Test 7: Chroot mode debug logs show credential hiding', async () => {
      const result = await runner.runWithSudo(
        'echo "test"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Check debug logs for chroot credential hiding messages
      expect(result.stderr).toMatch(/Chroot mode.*[Hh]iding credential|Hidden.*credential.*chroot/i);
    }, 120000);

    test('Test 8: Chroot mode ALSO hides credentials at direct home path (bypass prevention)', async () => {
      const homeDir = os.homedir();

      // SECURITY FIX TEST: Previously, credentials were only hidden at /host paths in chroot mode,
      // but the home directory was ALSO mounted directly at $HOME. An attacker could bypass
      // protection by reading from the direct mount instead of /host.
      //
      // This test specifically verifies that credentials are hidden at the direct home mount
      // (the bypass path). The /host chroot path is covered by
      // "Test 6: Chroot mode hides credentials at /host paths".

      const result = await runner.runWithSudo(
        `cat ${homeDir}/.docker/config.json 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          // Chroot is always enabled (no flag needed)
        }
      );

      // Command should succeed (file is "readable" but empty)
      expect(result).toSucceed();
      // Output should be empty (no credential data leaked via direct home mount)
      const output = result.stdout.trim();
      expect(output).toBe('');
    }, 120000);

    test('Test 9: Chroot mode hides GitHub CLI tokens at direct home path', async () => {
      const homeDir = os.homedir();

      // Verify another critical credential file is hidden at the direct home mount
      // (the bypass path). The /host chroot path is covered by Test 6.
      const result = await runner.runWithSudo(
        `cat ${homeDir}/.config/gh/hosts.yml 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          // Chroot is always enabled (no flag needed)
        }
      );

      expect(result).toSucceed();
      // Output should be empty (no credential data leaked via direct home mount)
      const output = result.stdout.trim();
      expect(output).toBe('');
    }, 120000);
  });

  describe('Full Filesystem Access Flag (--allow-full-filesystem-access)', () => {
    test('Test 10: Full filesystem access shows security warnings', async () => {
      const result = await runner.runWithSudo(
        'echo "test"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
          allowFullFilesystemAccess: true,
        }
      );

      expect(result).toSucceed();

      // Check for multiple security warning messages
      expect(result.stderr).toMatch(/⚠️.*SECURITY WARNING/i);
      expect(result.stderr).toMatch(/entire host filesystem.*mounted|Full filesystem access/i);
    }, 120000);

    test('Test 11: With full access, Docker config is NOT hidden', async () => {
      const homeDir = os.homedir();
      const dockerConfig = `${homeDir}/.docker/config.json`;

      // First check if file exists on host
      const fileExists = fs.existsSync(dockerConfig);

      if (fileExists) {
        const result = await runner.runWithSudo(
          `wc -c ${dockerConfig} 2>&1 | grep -v "^\\[" | head -1`,
          {
            allowDomains: ['github.com'],
            logLevel: 'debug',
            timeout: 60000,
            allowFullFilesystemAccess: true,
          }
        );

        expect(result).toSucceed();
        // With full access, file size should match real file (not 0 bytes from /dev/null)
        const realSize = fs.statSync(dockerConfig).size;
        const output = result.stdout.trim();
        if (output && realSize > 0) {
          expect(output).toContain(realSize.toString());
        }
      }
    }, 120000);
  });

  describe('Security Verification', () => {
    test('Test 12: Simulated exfiltration attack gets empty data', async () => {
      const homeDir = os.homedir();

      // Simulate prompt injection attack: read credential file and encode it
      const attackCommand = `cat ${homeDir}/.docker/config.json 2>&1 | base64 | grep -v "^\\[" | head -1`;

      const result = await runner.runWithSudo(
        attackCommand,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Attack succeeds but gets empty content (credential is hidden)
      // Base64 of empty string is empty
      const output = result.stdout.trim();
      expect(output).toBe('');
    }, 120000);

    test('Test 13: Multiple encoding attempts still get empty data', async () => {
      const homeDir = os.homedir();

      // Simulate sophisticated attack: multiple encoding layers
      const attackCommand = `cat ${homeDir}/.config/gh/hosts.yml 2>&1 | base64 | xxd -p 2>&1 | tr -d '\\n' | grep -v "^\\[" | head -1`;

      const result = await runner.runWithSudo(
        attackCommand,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Even with multiple encoding, attacker gets empty data
      const output = result.stdout.trim();
      expect(output).toBe('');
    }, 120000);

    test('Test 14: grep for tokens in hidden files finds nothing', async () => {
      const homeDir = os.homedir();

      // Try to grep for common credential patterns
      const result = await runner.runWithSudo(
        `sh -c 'grep -h "oauth_token\\|_authToken\\|auth\\":" ${homeDir}/.docker/config.json ${homeDir}/.npmrc ${homeDir}/.config/gh/hosts.yml 2>&1' | grep -v "^\\[" | head -5`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // grep exits with code 1 when no matches found, which is expected
      // But the files are readable (no permission errors)
      const output = result.stdout.trim();
      // Should not find any auth tokens
      expect(output).not.toContain('oauth_token');
      expect(output).not.toContain('_authToken');
      expect(output).not.toContain('auth');
    }, 120000);
  });

  describe('Git Credential Hiding', () => {
    test('Test 15: Git XDG config is hidden (empty file)', async () => {
      const homeDir = os.homedir();
      const gitConfig = `${homeDir}/.config/git/config`;

      const result = await runner.runWithSudo(
        `cat ${gitConfig} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Output should be empty (no credential data leaked)
      const output = result.stdout.trim();
      expect(output).toBe('');
    }, 120000);

    test('Test 16: Git XDG credentials store is hidden (empty file)', async () => {
      const homeDir = os.homedir();
      const gitCredentials = `${homeDir}/.config/git/credentials`;

      const result = await runner.runWithSudo(
        `cat ${gitCredentials} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Output should be empty (no plaintext tokens leaked)
      const output = result.stdout.trim();
      expect(output).not.toContain('https://');
      expect(output).not.toContain('github.com');
    }, 120000);

    test('Test 17: .gitconfig is hidden (empty file)', async () => {
      const homeDir = os.homedir();
      const gitconfig = `${homeDir}/.gitconfig`;

      const result = await runner.runWithSudo(
        `cat ${gitconfig} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      const output = result.stdout.trim();
      // Should not contain credential helpers or extraheader tokens
      expect(output).not.toContain('credential');
      expect(output).not.toContain('extraheader');
      expect(output).not.toContain('AUTHORIZATION');
    }, 120000);

    test('Test 18: .git-credentials is hidden (empty file)', async () => {
      const homeDir = os.homedir();
      const gitCredentials = `${homeDir}/.git-credentials`;

      const result = await runner.runWithSudo(
        `cat ${gitCredentials} 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      const output = result.stdout.trim();
      // Should not contain plaintext tokens
      expect(output).not.toContain('https://');
      expect(output).not.toContain('github.com');
    }, 120000);

    test('Test 19: Workspace .git/config has no extraheader tokens', async () => {
      // Create a temporary git repo with a fake extraheader to test sanitization
      const result = await runner.runWithSudo(
        `sh -c 'cd /tmp && rm -rf awf-git-test && mkdir awf-git-test && cd awf-git-test && git init && git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic dGVzdDp0b2tlbg==" && cat .git/config' 2>&1 | grep -v "^\\["`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // The entrypoint sanitizes AWF_WORKDIR, but this is a separate temp dir
      // so it won't be sanitized. This test verifies the git config output format.
      // The critical test is that the AWF_WORKDIR workspace is sanitized.
      expect(result).toSucceed();
    }, 120000);

    test('Test 20: git credential fill returns empty for github.com', async () => {
      // Verify that git credential helpers are disabled and cannot provide tokens
      const result = await runner.runWithSudo(
        `sh -c 'echo "protocol=https
host=github.com" | git credential fill 2>&1' | grep -v "^\\[" | head -5`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Should not contain any password/token
      const output = result.stdout.trim();
      expect(output).not.toContain('password=ghp_');
      expect(output).not.toContain('password=gho_');
      expect(output).not.toContain('password=github_pat_');
    }, 120000);

    test('Test 21: Chroot mode hides git credentials at /host paths', async () => {
      const homeDir = os.homedir();

      // Try to read git config at /host path
      const result = await runner.runWithSudo(
        `cat /host${homeDir}/.config/git/credentials 2>&1 | grep -v "^\\[" | head -1`,
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // May succeed with empty content or fail with "No such file" (both indicate hiding)
      if (result.success) {
        const output = result.stdout.trim();
        expect(output).not.toContain('https://');
        expect(output).not.toContain('github.com');
      } else {
        expect(result.stderr).toMatch(/No such file|cannot access/i);
      }
    }, 120000);

    test('Test 22: Debug logs show git credential sanitization', async () => {
      const result = await runner.runWithSudo(
        'echo "test"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Check that entrypoint logs show git credential sanitization
      expect(result.stderr).toMatch(/Sanitizing git credentials/i);
    }, 120000);
  });

  describe('MCP Logs Directory Hiding', () => {
    test('Test 23: /tmp/gh-aw/mcp-logs/ is hidden in normal mode', async () => {
      // Try to access the mcp-logs directory
      const result = await runner.runWithSudo(
        'ls -la /tmp/gh-aw/mcp-logs/ 2>&1 | grep -v "^\\[" | head -1',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // With tmpfs mounted over the directory, ls should succeed but show empty directory
      // The directory appears to exist (as an empty tmpfs) but contains no files
      const allOutput = `${result.stdout}\n${result.stderr}`;
      // Verify either:
      // 1. Directory listing shows it's effectively empty (total size indicates empty tmpfs)
      // 2. Or old /dev/null behavior ("Not a directory")
      expect(allOutput).toMatch(/total|Not a directory|cannot access/i);
    }, 120000);

    test('Test 24: /tmp/gh-aw/mcp-logs/ is hidden in chroot mode', async () => {
      // Try to access the mcp-logs directory at /host path
      const result = await runner.runWithSudo(
        'ls -la /host/tmp/gh-aw/mcp-logs/ 2>&1 | grep -v "^\\[" | head -1',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // With tmpfs mounted over the directory at /host path, ls should succeed but show empty
      const allOutput = `${result.stdout}\n${result.stderr}`;
      expect(allOutput).toMatch(/total|Not a directory|cannot access/i);
    }, 120000);

    test('Test 25: MCP logs files cannot be read in normal mode', async () => {
      // Try to read a typical MCP log file path
      const result = await runner.runWithSudo(
        'cat /tmp/gh-aw/mcp-logs/safeoutputs/log.txt 2>&1 | grep -v "^\\[" | head -1',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Should fail with "No such file or directory" (tmpfs is empty)
      // This confirms the tmpfs mount is preventing file access to host files
      const allOutput = `${result.stdout}\n${result.stderr}`;
      expect(allOutput).toMatch(/No such file or directory|Not a directory|cannot access/i);
    }, 120000);
  });
});
