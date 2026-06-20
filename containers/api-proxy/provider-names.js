'use strict';

/**
 * Centralized provider name constants.
 *
 * Use these instead of bare string literals when comparing provider names so
 * that provider checks are spelling-safe and easy to find/refactor.
 *
 * NB: this module is intentionally named `provider-names` rather than
 * `providers` to avoid colliding with the `providers/` directory (the upstream
 * adapter registry resolved via `require('./providers')`).
 */
const PROVIDER_ANTHROPIC = 'anthropic';
const PROVIDER_OPENAI = 'openai';
const PROVIDER_COPILOT = 'copilot';
const PROVIDER_GEMINI = 'gemini';

module.exports = {
  PROVIDER_ANTHROPIC,
  PROVIDER_OPENAI,
  PROVIDER_COPILOT,
  PROVIDER_GEMINI,
};
