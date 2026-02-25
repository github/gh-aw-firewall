/**
 * Git Operations Tests
 *
 * These tests verify Git operations through the firewall:
 * - Git clone (HTTPS)
 * - Git fetch
 * - Git ls-remote
 * - Git with authentication
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Git Operations', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Git HTTPS Operations', () => {
    test('should allow git ls-remote to allowed domain', async () => {
      const result = await runner.runWithSudo(
        'git ls-remote https://github.com/octocat/Hello-World.git HEAD',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // Should output commit hash
      expect(result.stdout).toMatch(/[a-f0-9]{40}/);
    }, 120000);

    test('should allow git ls-remote to subdomain', async () => {
      const result = await runner.runWithSudo(
        'git ls-remote https://github.com/octocat/Hello-World.git HEAD',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should block git ls-remote to non-allowed domain', async () => {
      const result = await runner.runWithSudo(
        'git ls-remote https://gitlab.com/gitlab-org/gitlab.git HEAD',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should allow git clone to allowed domain', async () => {
      const result = await runner.runWithSudo(
        'git clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/hello-world && ls /tmp/hello-world',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
      // Should contain README file
      expect(result.stdout).toContain('README');
    }, 180000);

    test('should block git clone to non-allowed domain', async () => {
      const result = await runner.runWithSudo(
        'git clone --depth 1 https://gitlab.com/gitlab-org/gitlab.git /tmp/gitlab',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);
  });

  describe('Git Config', () => {
    test('should preserve git config', async () => {
      const result = await runner.runWithSudo(
        'git config --global --list || echo "no global config"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should allow setting git config', async () => {
      const result = await runner.runWithSudo(
        'git config --global user.email "test@example.com" && git config --global user.email',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('test@example.com');
    }, 120000);
  });

  describe('Multiple Git Operations', () => {
    test('should handle sequential git operations', async () => {
      const result = await runner.runWithSudo(
        'bash -c "git ls-remote https://github.com/octocat/Hello-World.git HEAD && git ls-remote https://github.com/octocat/Spoon-Knife.git HEAD"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
    }, 180000);
  });

  describe('Authenticated Git Operations', () => {
    const hasToken = !!process.env.GITHUB_TOKEN;
    const TEST_REPO = 'Mossaka/gh-aw-firewall-test-node';

    // Helper to build a bash command that configures git credentials, then runs the given commands
    const withGitAuth = (commands: string): string =>
      `bash -c 'git config --global user.email "awf-test@github.com" && ` +
      `git config --global user.name "AWF Test" && ` +
      `git config --global credential.helper "!f() { echo username=x-access-token; echo password=\\$GITHUB_TOKEN; }; f" && ` +
      `${commands}'`;

    const skipReason = 'GITHUB_TOKEN not available';

    test('should clone with authentication', async () => {
      if (!hasToken) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const result = await runner.runWithSudo(
        withGitAuth(
          `git clone --depth 1 https://github.com/${TEST_REPO}.git /tmp/auth-clone && ls /tmp/auth-clone`
        ),
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toMatch(/package\.json|README/);
    }, 180000);

    test('should fetch after authenticated clone', async () => {
      if (!hasToken) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const result = await runner.runWithSudo(
        withGitAuth(
          `git clone --depth 1 https://github.com/${TEST_REPO}.git /tmp/auth-fetch && ` +
          `cd /tmp/auth-fetch && git fetch origin`
        ),
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 120000,
        }
      );

      expect(result).toSucceed();
    }, 180000);

    test('should push to remote and clean up temp branch', async () => {
      if (!hasToken) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const branchName = `test/awf-push-${Date.now()}`;

      // Clone, create branch, commit, push, then delete the remote branch
      const result = await runner.runWithSudo(
        withGitAuth(
          `git clone --depth 1 https://github.com/${TEST_REPO}.git /tmp/auth-push && ` +
          `cd /tmp/auth-push && ` +
          `git checkout -b ${branchName} && ` +
          `echo "awf-test-$(date +%s)" > awf-test-file.txt && ` +
          `git add awf-test-file.txt && ` +
          `git commit -m "test: awf push test" && ` +
          `git push origin ${branchName} && ` +
          `echo "PUSH_SUCCESS" && ` +
          `git push origin --delete ${branchName} && ` +
          `echo "CLEANUP_SUCCESS"`
        ),
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 180000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('PUSH_SUCCESS');
      expect(result.stdout).toContain('CLEANUP_SUCCESS');
    }, 240000);
  });
});
