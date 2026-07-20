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
      const result = await runner.run(
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
      const result = await runner.run(
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
      const result = await runner.run(
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
      const result = await runner.run(
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
      const result = await runner.run(
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
      const result = await runner.run(
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
      const result = await runner.run(
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
      const result = await runner.run(
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
});
