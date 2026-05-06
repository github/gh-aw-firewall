/**
 * Shared Docker test fixtures used across compose-generator and service unit tests.
 *
 * Note: `jest.mock('execa', ...)` along with the `mockExecaFn`/`mockExecaSync`
 * declarations must remain in each individual test file. Jest hoists jest.mock()
 * calls to the top of each file before imports are resolved, so the factory
 * closure cannot reference variables from an imported module.
 */

import { WrapperConfig } from '../types';

/**
 * Baseline WrapperConfig used in unit tests. Omits `workDir` so each test can
 * supply its own temporary directory.
 */
export const baseConfig: Omit<WrapperConfig, 'workDir'> = {
  allowedDomains: ['github.com', 'npmjs.org'],
  agentCommand: 'echo "test"',
  logLevel: 'info',
  keepContainers: false,
  buildLocal: false,
  imageRegistry: 'ghcr.io/github/gh-aw-firewall',
  imageTag: 'latest',
};

/**
 * Standard network configuration for the AWF Docker network used in unit tests.
 */
export const mockNetworkConfig = {
  subnet: '172.30.0.0/24',
  squidIp: '172.30.0.10',
  agentIp: '172.30.0.20',
};
