/**
 * Environment variable name constants for the API proxy provider adapters.
 *
 * This is the single source of truth for env var names on the TypeScript host side.
 * The CommonJS equivalent lives in containers/api-proxy/provider-env-constants.js.
 *
 * Both files must be kept in sync when adding or renaming env vars.
 */

/** Environment variable names for the OpenAI provider adapter. */
export const OPENAI_ENV = {
  KEY: 'OPENAI_API_KEY',
  TARGET: 'OPENAI_API_TARGET',
  BASE_PATH: 'OPENAI_API_BASE_PATH',
  AUTH_HEADER: 'AWF_OPENAI_AUTH_HEADER',
} as const;

/** Environment variable names for the Anthropic provider adapter. */
export const ANTHROPIC_ENV = {
  KEY: 'ANTHROPIC_API_KEY',
  TARGET: 'ANTHROPIC_API_TARGET',
  BASE_PATH: 'ANTHROPIC_API_BASE_PATH',
  AUTH_HEADER: 'AWF_ANTHROPIC_AUTH_HEADER',
} as const;

/** Environment variable names for the Gemini provider adapter. */
export const GEMINI_ENV = {
  KEY: 'GEMINI_API_KEY',
  TARGET: 'GEMINI_API_TARGET',
  BASE_PATH: 'GEMINI_API_BASE_PATH',
} as const;

/** Environment variable names for the Copilot provider adapter. */
export const COPILOT_ENV = {
  GITHUB_TOKEN: 'COPILOT_GITHUB_TOKEN',
  PROVIDER_API_KEY: 'COPILOT_PROVIDER_API_KEY',
  PROVIDER_TYPE: 'COPILOT_PROVIDER_TYPE',
  PROVIDER_BASE_URL: 'COPILOT_PROVIDER_BASE_URL',
  API_TARGET: 'COPILOT_API_TARGET',
  API_BASE_PATH: 'COPILOT_API_BASE_PATH',
} as const;
