/**
 * Shared test fixtures for api-proxy-service test modules.
 *
 * Note: `jest.mock('execa', ...)` along with the `mockConfig` let-binding and
 * `useTempWorkDir()` call must remain in each individual test file. Jest hoists
 * jest.mock() calls to the top of each file before imports are resolved, so the
 * factory closure cannot reference variables from an imported module.
 */

import { mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';

/**
 * Standard network configuration for the AWF Docker network with API proxy IP.
 * Used across api-proxy-service test modules.
 */
export const mockNetworkConfigWithProxy = {
  ...mockNetworkConfig,
  proxyIp: '172.30.0.30',
};

const oidcVars = [
  'AWF_AUTH_TYPE',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
] as const;

/**
 * Saves and clears OIDC-related environment variables for test isolation.
 * Returns a restore callback to reinstate prior values after each test.
 */
export function saveAndClearOidcEnvironment(): () => void {
  const savedEnv: Record<string, string | undefined> = {};

  for (const key of oidcVars) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  return () => {
    for (const key of oidcVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  };
}
