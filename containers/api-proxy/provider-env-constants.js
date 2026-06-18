'use strict';

/**
 * Environment variable name constants for the API proxy provider adapters.
 *
 * This is the single source of truth for env var names on the container JS side.
 * The TypeScript equivalent lives in src/api-proxy-env-constants.ts.
 *
 * Both files must be kept in sync when adding or renaming env vars.
 */

/** Environment variable names for the OpenAI provider adapter. */
const OPENAI_ENV = /** @type {const} */ ({
  KEY: 'OPENAI_API_KEY',
  TARGET: 'OPENAI_API_TARGET',
  BASE_PATH: 'OPENAI_API_BASE_PATH',
  AUTH_HEADER: 'AWF_OPENAI_AUTH_HEADER',
});

/** Environment variable names for the Anthropic provider adapter. */
const ANTHROPIC_ENV = /** @type {const} */ ({
  KEY: 'ANTHROPIC_API_KEY',
  TARGET: 'ANTHROPIC_API_TARGET',
  BASE_PATH: 'ANTHROPIC_API_BASE_PATH',
  AUTH_HEADER: 'AWF_ANTHROPIC_AUTH_HEADER',
});

/** Environment variable names for the Gemini provider adapter. */
const GEMINI_ENV = /** @type {const} */ ({
  KEY: 'GEMINI_API_KEY',
  TARGET: 'GEMINI_API_TARGET',
  BASE_PATH: 'GEMINI_API_BASE_PATH',
});

/** Environment variable names for the Copilot provider adapter. */
const COPILOT_ENV = /** @type {const} */ ({
  GITHUB_TOKEN: 'COPILOT_GITHUB_TOKEN',
  PROVIDER_API_KEY: 'COPILOT_PROVIDER_API_KEY',
  PROVIDER_TYPE: 'COPILOT_PROVIDER_TYPE',
  PROVIDER_BASE_URL: 'COPILOT_PROVIDER_BASE_URL',
  API_TARGET: 'COPILOT_API_TARGET',
  API_BASE_PATH: 'COPILOT_API_BASE_PATH',
});

module.exports = {
  OPENAI_ENV,
  ANTHROPIC_ENV,
  GEMINI_ENV,
  COPILOT_ENV,
};
