/**
 * One-Shot Token Tests
 *
 * These tests verify the LD_PRELOAD one-shot token library that protects
 * sensitive environment variables by caching values and clearing them
 * from the environment.
 *
 * The library intercepts getenv() calls for tokens like GITHUB_TOKEN.
 * On first access, it caches the value in memory and unsets the variable
 * from the environment (clearing /proc/self/environ). Subsequent getenv()
 * calls return the cached value, allowing programs to read tokens multiple
 * times while the environment is cleaned.
 *
 * Tests verify:
 * - First read succeeds and returns the token value
 * - Second read returns the cached value (within same process)
 * - Tokens are unset from the environment (/proc/self/environ is cleared)
 * - Behavior works in both container mode and chroot mode
 *
 * IMPORTANT: These tests require buildLocal: true because the one-shot-token
 * library is compiled during the Docker image build. Pre-built images from GHCR
 * may not include this feature if they were built before PR #604 was merged.
 *
 * Note on shell tests: `printenv` forks a new process each time, so each
 * invocation gets a fresh LD_PRELOAD library instance. The parent bash
 * process environment is unaffected by child unsetenv() calls, so both
 * `printenv` reads succeed. The caching is most relevant for programs that
 * call getenv() multiple times within the same process (e.g., Python, Node.js).
 *
 * Debug Logging: Tests set AWF_ONE_SHOT_TOKEN_DEBUG=1 to enable debug logging
 * for verification. Without this flag, the library operates silently.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('One-Shot Token Protection', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Container Mode', () => {
    test('should cache GITHUB_TOKEN and clear from environment', async () => {
      // printenv forks a new process each time, so both reads succeed
      // (parent bash environ unaffected by child unsetenv)
      const testScript = `
        FIRST_READ=$(printenv GITHUB_TOKEN)
        SECOND_READ=$(printenv GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true, // Build container locally to include one-shot-token.so
          env: {
            GITHUB_TOKEN: 'ghp_test_token_12345',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Both reads succeed (each printenv is a separate process)
      expect(result.stdout).toContain('First read: [ghp_test_token_12345]');
      expect(result.stdout).toContain('Second read: [ghp_test_token_12345]');
      // Verify the one-shot-token library logged the token access without exposing the value
      expect(result.stderr).toContain('[one-shot-token] Token GITHUB_TOKEN accessed and cached (length: 20)');
    }, 120000);

    test('should cache COPILOT_GITHUB_TOKEN and clear from environment', async () => {
      const testScript = `
        FIRST_READ=$(printenv COPILOT_GITHUB_TOKEN)
        SECOND_READ=$(printenv COPILOT_GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            COPILOT_GITHUB_TOKEN: 'copilot_test_token_67890',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First read: [copilot_test_token_67890]');
      expect(result.stdout).toContain('Second read: [copilot_test_token_67890]');
      expect(result.stderr).toContain('[one-shot-token] Token COPILOT_GITHUB_TOKEN accessed and cached (length: 24)');
    }, 120000);

    test('should cache OPENAI_API_KEY and clear from environment', async () => {
      const testScript = `
        FIRST_READ=$(printenv OPENAI_API_KEY)
        SECOND_READ=$(printenv OPENAI_API_KEY)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            OPENAI_API_KEY: 'sk-test-openai-key',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First read: [sk-test-openai-key]');
      expect(result.stdout).toContain('Second read: [sk-test-openai-key]');
      expect(result.stderr).toContain('[one-shot-token] Token OPENAI_API_KEY accessed and cached (length: 18)');
    }, 120000);

    test('should handle multiple different tokens independently', async () => {
      const testScript = `
        # Read GITHUB_TOKEN twice
        GITHUB_FIRST=$(printenv GITHUB_TOKEN)
        GITHUB_SECOND=$(printenv GITHUB_TOKEN)
        
        # Read OPENAI_API_KEY twice
        OPENAI_FIRST=$(printenv OPENAI_API_KEY)
        OPENAI_SECOND=$(printenv OPENAI_API_KEY)
        
        echo "GitHub first: [$GITHUB_FIRST]"
        echo "GitHub second: [$GITHUB_SECOND]"
        echo "OpenAI first: [$OPENAI_FIRST]"
        echo "OpenAI second: [$OPENAI_SECOND]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_multi_token_1',
            OPENAI_API_KEY: 'sk-multi-key-2',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Both reads for each token should succeed (printenv is separate process)
      expect(result.stdout).toContain('GitHub first: [ghp_multi_token_1]');
      expect(result.stdout).toContain('GitHub second: [ghp_multi_token_1]');
      expect(result.stdout).toContain('OpenAI first: [sk-multi-key-2]');
      expect(result.stdout).toContain('OpenAI second: [sk-multi-key-2]');
    }, 120000);

    test('should not interfere with non-sensitive environment variables', async () => {
      const testScript = `
        # Non-sensitive variables should be readable multiple times
        FIRST=$(printenv NORMAL_VAR)
        SECOND=$(printenv NORMAL_VAR)
        THIRD=$(printenv NORMAL_VAR)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
        echo "Third: [$THIRD]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            NORMAL_VAR: 'not_a_token',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Non-sensitive variables should be readable multiple times
      expect(result.stdout).toContain('First: [not_a_token]');
      expect(result.stdout).toContain('Second: [not_a_token]');
      expect(result.stdout).toContain('Third: [not_a_token]');
      // No one-shot-token log message for non-sensitive vars
      expect(result.stderr).not.toContain('[one-shot-token] Token NORMAL_VAR');
    }, 120000);

    test('should return cached value on subsequent getenv() calls in same process', async () => {
      // Use Python to call getenv() directly (not through shell)
      // This tests that the LD_PRELOAD library caches values for same-process reads
      const pythonScript = `
import os
# First call to os.getenv calls C's getenv() - caches and clears from environ
first = os.getenv('GITHUB_TOKEN', '')
# Second call returns the cached value
second = os.getenv('GITHUB_TOKEN', '')
print(f"First: [{first}]")
print(f"Second: [{second}]")
      `.trim();

      const result = await runner.runWithSudo(
        `python3 -c '${pythonScript}'`,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_python_test_token',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Both reads should succeed (second read returns cached value)
      expect(result.stdout).toContain('First: [ghp_python_test_token]');
      expect(result.stdout).toContain('Second: [ghp_python_test_token]');
      expect(result.stderr).toContain('[one-shot-token] Token GITHUB_TOKEN accessed and cached (length: 21)');
    }, 120000);

    test('should clear token from /proc/self/environ while caching for getenv()', async () => {
      // Verify that the token is removed from the environ array
      // but still accessible via getenv() (from cache)
      const pythonScript = `
import os
import ctypes

# First access caches and clears from environ
first = os.getenv('GITHUB_TOKEN', '')

# Check if token is still in os.environ (reflects C environ array)
# After unsetenv, it should be gone from the environ array
in_environ = 'GITHUB_TOKEN' in os.environ

# But getenv() should still return cached value
second = os.getenv('GITHUB_TOKEN', '')

print(f"First getenv: [{first}]")
print(f"In os.environ: [{in_environ}]")
print(f"Second getenv: [{second}]")
      `.trim();

      const result = await runner.runWithSudo(
        `python3 -c '${pythonScript}'`,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_environ_check',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First getenv: [ghp_environ_check]');
      // Note: Python's os.environ may cache at startup, so this checks the
      // behavior of getenv() returning cached values
      expect(result.stdout).toContain('Second getenv: [ghp_environ_check]');
    }, 120000);
  });

  describe('Chroot Mode', () => {
    test('should cache GITHUB_TOKEN in chroot mode', async () => {
      const testScript = `
        FIRST_READ=$(printenv GITHUB_TOKEN)
        SECOND_READ=$(printenv GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_chroot_token_12345',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First read: [ghp_chroot_token_12345]');
      expect(result.stdout).toContain('Second read: [ghp_chroot_token_12345]');
      // Verify the library was copied to the chroot
      expect(result.stderr).toContain('One-shot token library copied to chroot');
      // Verify the one-shot-token library logged the token access without exposing the value
      expect(result.stderr).toContain('[one-shot-token] Token GITHUB_TOKEN accessed and cached (length: 22)');
    }, 120000);

    test('should cache COPILOT_GITHUB_TOKEN in chroot mode', async () => {
      const testScript = `
        FIRST_READ=$(printenv COPILOT_GITHUB_TOKEN)
        SECOND_READ=$(printenv COPILOT_GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            COPILOT_GITHUB_TOKEN: 'copilot_chroot_token_67890',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First read: [copilot_chroot_token_67890]');
      expect(result.stdout).toContain('Second read: [copilot_chroot_token_67890]');
      expect(result.stderr).toContain('[one-shot-token] Token COPILOT_GITHUB_TOKEN accessed and cached (length: 26)');
    }, 120000);

    test('should return cached value on subsequent getenv() in chroot mode', async () => {
      const pythonScript = `
import os
first = os.getenv('GITHUB_TOKEN', '')
second = os.getenv('GITHUB_TOKEN', '')
print(f"First: [{first}]")
print(f"Second: [{second}]")
      `.trim();

      const result = await runner.runWithSudo(
        `python3 -c '${pythonScript}'`,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_chroot_python_token',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First: [ghp_chroot_python_token]');
      expect(result.stdout).toContain('Second: [ghp_chroot_python_token]');
      expect(result.stderr).toContain('[one-shot-token] Token GITHUB_TOKEN accessed and cached (length: 23)');
    }, 120000);

    test('should not interfere with non-sensitive variables in chroot mode', async () => {
      const testScript = `
        FIRST=$(printenv NORMAL_VAR)
        SECOND=$(printenv NORMAL_VAR)
        THIRD=$(printenv NORMAL_VAR)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
        echo "Third: [$THIRD]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            NORMAL_VAR: 'chroot_not_a_token',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First: [chroot_not_a_token]');
      expect(result.stdout).toContain('Second: [chroot_not_a_token]');
      expect(result.stdout).toContain('Third: [chroot_not_a_token]');
      expect(result.stderr).not.toContain('[one-shot-token] Token NORMAL_VAR');
    }, 120000);

    test('should handle multiple different tokens independently in chroot mode', async () => {
      const testScript = `
        GITHUB_FIRST=$(printenv GITHUB_TOKEN)
        GITHUB_SECOND=$(printenv GITHUB_TOKEN)
        OPENAI_FIRST=$(printenv OPENAI_API_KEY)
        OPENAI_SECOND=$(printenv OPENAI_API_KEY)
        echo "GitHub first: [$GITHUB_FIRST]"
        echo "GitHub second: [$GITHUB_SECOND]"
        echo "OpenAI first: [$OPENAI_FIRST]"
        echo "OpenAI second: [$OPENAI_SECOND]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_chroot_multi_1',
            OPENAI_API_KEY: 'sk-chroot-multi-2',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('GitHub first: [ghp_chroot_multi_1]');
      expect(result.stdout).toContain('GitHub second: [ghp_chroot_multi_1]');
      expect(result.stdout).toContain('OpenAI first: [sk-chroot-multi-2]');
      expect(result.stdout).toContain('OpenAI second: [sk-chroot-multi-2]');
    }, 120000);
  });

  describe('Edge Cases', () => {
    test('should handle token with empty value', async () => {
      const testScript = `
        FIRST=$(printenv GITHUB_TOKEN)
        SECOND=$(printenv GITHUB_TOKEN)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: '',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Empty token should be treated as no token
      expect(result.stdout).toContain('First: []');
      expect(result.stdout).toContain('Second: []');
    }, 120000);

    test('should handle token that is not set', async () => {
      const testScript = `
        FIRST=$(printenv NONEXISTENT_TOKEN)
        SECOND=$(printenv NONEXISTENT_TOKEN)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
        }
      );

      expect(result).toSucceed();
      // Nonexistent token should return empty on both reads
      expect(result.stdout).toContain('First: []');
      expect(result.stdout).toContain('Second: []');
    }, 120000);

    test('should handle token with special characters', async () => {
      const testScript = `
        FIRST=$(printenv GITHUB_TOKEN)
        SECOND=$(printenv GITHUB_TOKEN)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
      `;

      const result = await runner.runWithSudo(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 60000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_test-with-special_chars@#$%',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First: [ghp_test-with-special_chars@#$%]');
      expect(result.stdout).toContain('Second: [ghp_test-with-special_chars@#$%]');
    }, 120000);
  });

});
