import {
  deriveCopilotApiBasePathFromProviderBaseUrl,
  deriveCopilotApiTargetFromProviderBaseUrl,
} from './copilot-api-resolver.internal';

/**
 * Test-only helpers for copilot-api-resolver.
 * Tests should import from this file, not directly from the production module.
 */
export const copilotApiResolverTestHelpers = {
  deriveCopilotApiTargetFromProviderBaseUrl,
  deriveCopilotApiBasePathFromProviderBaseUrl,
};
