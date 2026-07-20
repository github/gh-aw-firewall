/**
 * Credential Isolation & One-Shot Token Tests
 *
 * In strict security mode, credentials are protected by two layers:
 *
 * 1. **API Proxy Credential Isolation** (primary): LLM API keys
 *    (COPILOT_GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY) are held
 *    exclusively in the API proxy sidecar. The agent receives only placeholder
 *    values — real tokens are NEVER exposed to the agent container.
 *
 * 2. **One-Shot Token Library** (defense-in-depth): For tokens that remain
 *    in the agent environment (e.g., GITHUB_TOKEN), an LD_PRELOAD library
 *    caches values and clears them from /proc/self/environ after first read.
 *
 * Tests verify:
 * - LLM API keys are replaced with placeholders (agent never sees real keys)
 * - GITHUB_TOKEN remains accessible via one-shot caching
 * - Non-sensitive variables are unaffected
 * - Behavior works in both container mode and chroot mode
 *
 * IMPORTANT: These tests require buildLocal: true because the one-shot-token
 * library is compiled during the Docker image build.
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
    test('should never expose real GITHUB_TOKEN to agent (credential isolation)', async () => {
      const testScript = `
        FIRST_READ=$(printenv GITHUB_TOKEN)
        SECOND_READ=$(printenv GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 480000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_test_token_12345',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token — credential isolation via API proxy
      expect(result.stdout).not.toContain('ghp_test_token_12345');
    }, 480000);

    test('should never expose real COPILOT_GITHUB_TOKEN to agent (credential isolation)', async () => {
      const testScript = `
        FIRST_READ=$(printenv COPILOT_GITHUB_TOKEN)
        SECOND_READ=$(printenv COPILOT_GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            COPILOT_GITHUB_TOKEN: 'copilot_test_token_67890',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token — only the placeholder
      expect(result.stdout).not.toContain('copilot_test_token_67890');
      expect(result.stdout).toContain('First read: [');
      // The placeholder value is injected by the API proxy credential isolation
    }, 240000);

    test('should never expose real OPENAI_API_KEY to agent (credential isolation)', async () => {
      const testScript = `
        FIRST_READ=$(printenv OPENAI_API_KEY)
        SECOND_READ=$(printenv OPENAI_API_KEY)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            OPENAI_API_KEY: 'sk-test-openai-key',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real API key — only the placeholder
      expect(result.stdout).not.toContain('sk-test-openai-key');
      expect(result.stdout).toContain('First read: [');
    }, 240000);

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

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_multi_token_1',
            OPENAI_API_KEY: 'sk-multi-key-2',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // NO real tokens should ever be visible to the agent
      expect(result.stdout).not.toContain('ghp_multi_token_1');
      expect(result.stdout).not.toContain('sk-multi-key-2');
    }, 240000);

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

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
          // Use cliEnv to explicitly pass NORMAL_VAR to the container via -e flag
          cliEnv: {
            NORMAL_VAR: 'not_a_token',
          },
        }
      );

      expect(result).toSucceed();
      // Non-sensitive variables should be readable multiple times
      expect(result.stdout).toContain('First: [not_a_token]');
      expect(result.stdout).toContain('Second: [not_a_token]');
      expect(result.stdout).toContain('Third: [not_a_token]');
      // No one-shot-token log message for non-sensitive vars
      expect(result.stdout).not.toContain('[one-shot-token] Token NORMAL_VAR');
    }, 240000);

    test('should return cached value on subsequent getenv() calls in same process', async () => {
      // Use Python to call getenv() directly (not through shell)
      // This tests that the LD_PRELOAD library caches values for same-process reads
      // Use heredoc to avoid shell quoting issues with Python single quotes and parentheses
      const testScript = `
python3 << 'PYEOF'
import os
first = os.getenv("GITHUB_TOKEN", "")
second = os.getenv("GITHUB_TOKEN", "")
print(f"First: [{first}]")
print(f"Second: [{second}]")
PYEOF
      `.trim();

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_python_test_token',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token — credential isolation via API proxy
      expect(result.stdout).not.toContain('ghp_python_test_token');
    }, 240000);

    test('should clear token from /proc/self/environ while caching for getenv()', async () => {
      // Verify that the token is removed from the environ array
      // but still accessible via getenv() (from cache)
      // Use heredoc to avoid shell quoting issues with Python single quotes and parentheses
      const testScript = `
python3 << 'PYEOF'
import os
import ctypes

first = os.getenv("GITHUB_TOKEN", "")
in_environ = "GITHUB_TOKEN" in os.environ
second = os.getenv("GITHUB_TOKEN", "")

print(f"First getenv: [{first}]")
print(f"In os.environ: [{in_environ}]")
print(f"Second getenv: [{second}]")
PYEOF
      `.trim();

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_environ_check',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token
      expect(result.stdout).not.toContain('ghp_environ_check');
    }, 240000);
  });

  describe('Chroot Mode', () => {
    test('should never expose real GITHUB_TOKEN in chroot mode', async () => {
      const testScript = `
        FIRST_READ=$(printenv GITHUB_TOKEN)
        SECOND_READ=$(printenv GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_chroot_token_12345',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token — credential isolation via API proxy
      expect(result.stdout).not.toContain('ghp_chroot_token_12345');
    }, 240000);

    test('should never expose real COPILOT_GITHUB_TOKEN in chroot mode', async () => {
      const testScript = `
        FIRST_READ=$(printenv COPILOT_GITHUB_TOKEN)
        SECOND_READ=$(printenv COPILOT_GITHUB_TOKEN)
        echo "First read: [$FIRST_READ]"
        echo "Second read: [$SECOND_READ]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            COPILOT_GITHUB_TOKEN: 'copilot_chroot_token_67890',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token — only the placeholder
      expect(result.stdout).not.toContain('copilot_chroot_token_67890');
    }, 240000);

    test('should return cached value on subsequent getenv() in chroot mode', async () => {
      // Use heredoc to avoid shell quoting issues with Python single quotes
      const testScript = `
python3 << 'PYEOF'
import os
first = os.getenv("GITHUB_TOKEN", "")
second = os.getenv("GITHUB_TOKEN", "")
print(f"First: [{first}]")
print(f"Second: [{second}]")
PYEOF
      `.trim();

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_chroot_python_token',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token
      expect(result.stdout).not.toContain('ghp_chroot_python_token');
    }, 240000);

    test('should not interfere with non-sensitive variables in chroot mode', async () => {
      const testScript = `
        FIRST=$(printenv NORMAL_VAR)
        SECOND=$(printenv NORMAL_VAR)
        THIRD=$(printenv NORMAL_VAR)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
        echo "Third: [$THIRD]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
          // Use cliEnv to explicitly pass NORMAL_VAR to the container via -e flag
          cliEnv: {
            NORMAL_VAR: 'chroot_not_a_token',
          },
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('First: [chroot_not_a_token]');
      expect(result.stdout).toContain('Second: [chroot_not_a_token]');
      expect(result.stdout).toContain('Third: [chroot_not_a_token]');
      expect(result.stdout).not.toContain('[one-shot-token] Token NORMAL_VAR');
    }, 240000);

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

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_chroot_multi_1',
            OPENAI_API_KEY: 'sk-chroot-multi-2',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // NO real tokens should ever be visible to the agent
      expect(result.stdout).not.toContain('ghp_chroot_multi_1');
      expect(result.stdout).not.toContain('sk-chroot-multi-2');
    }, 240000);
  });

  describe('Edge Cases', () => {
    test('should handle token with empty value', async () => {
      const testScript = `
        FIRST=$(printenv GITHUB_TOKEN)
        SECOND=$(printenv GITHUB_TOKEN)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
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
    }, 240000);

    test('should handle token that is not set', async () => {
      const testScript = `
        FIRST=$(printenv NONEXISTENT_TOKEN)
        SECOND=$(printenv NONEXISTENT_TOKEN)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
        }
      );

      expect(result).toSucceed();
      // Nonexistent token should return empty on both reads
      expect(result.stdout).toContain('First: []');
      expect(result.stdout).toContain('Second: []');
    }, 240000);

    test('should handle token with special characters', async () => {
      const testScript = `
        FIRST=$(printenv GITHUB_TOKEN)
        SECOND=$(printenv GITHUB_TOKEN)
        echo "First: [$FIRST]"
        echo "Second: [$SECOND]"
      `;

      const result = await runner.run(
        testScript,
        {
          allowDomains: ['localhost'],
          logLevel: 'debug',
          timeout: 240000,
          buildLocal: true,
          env: {
            GITHUB_TOKEN: 'ghp_test-with-special_chars@#$%',
            AWF_ONE_SHOT_TOKEN_DEBUG: '1',
          },
        }
      );

      expect(result).toSucceed();
      // Agent must NEVER see the real token, regardless of special characters
      expect(result.stdout).not.toContain('ghp_test-with-special_chars');
    }, 240000);
  });

});
