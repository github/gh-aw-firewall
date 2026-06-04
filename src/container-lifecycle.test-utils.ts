/**
 * Test-only access to container lifecycle state helpers.
 * Tests should import from this file, not from production modules.
 */
import { containerLifecycleStateTestHelpers, isAgentExternallyKilled } from './container-lifecycle-state';

export const containerLifecycleTestHelpers = {
  isAgentExternallyKilled,
  resetAgentExternallyKilled: containerLifecycleStateTestHelpers.resetAgentExternallyKilled,
};
