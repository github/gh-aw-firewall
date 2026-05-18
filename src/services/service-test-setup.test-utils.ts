/**
 * Shared test setup for service unit tests.
 *
 * Re-exports the common imports used across all service test files, so each
 * test file only needs a single import from this module for the shared pieces.
 *
 * Note: `jest.mock('execa', ...)` along with the `mockConfig` let-binding and
 * `useTempWorkDir()` call must remain in each individual test file. Jest hoists
 * jest.mock() calls to the top of each file before imports are resolved, so the
 * factory closure cannot reference variables from an imported module.
 */

export { generateDockerCompose } from '../compose-generator';
export type { WrapperConfig } from '../types';
export { baseConfig, mockNetworkConfig, useTempWorkDir } from '../test-helpers/docker-test-fixtures.test-utils';
