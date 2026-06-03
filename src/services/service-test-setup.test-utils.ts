/**
 * Shared test setup for service unit tests.
 *
 * Re-exports the common imports used across all service test files, so each
 * test file only needs a single import from this module for the shared pieces.
 *
 * Note: `jest.mock('execa', ...)` must remain in each individual test file.
 * Jest hoists jest.mock() calls to the top of each file before imports are
 * resolved, so the factory closure cannot reference variables from an imported
 * module.
 */

export { generateDockerCompose } from '../compose-generator';
export type { WrapperConfig } from '../types';
export { baseConfig, mockNetworkConfig, useTempWorkDir } from '../test-helpers/docker-test-fixtures.test-utils';

import type { WrapperConfig } from '../types';
import { baseConfig, useTempWorkDir } from '../test-helpers/docker-test-fixtures.test-utils';

/**
 * Encapsulates the repeated `let mockConfig` + `useTempWorkDir(baseConfig, …)`
 * boilerplate shared by all `agent-volumes-*.test.ts` files.
 *
 * Call this at the top level of the test file (outside any `describe` block)
 * and use the returned `getConfig` accessor inside your tests.
 *
 * @example
 * ```ts
 * const { getConfig } = useAgentVolumesTestConfig();
 * describe('agent service', () => {
 *   it('…', () => { const result = generateDockerCompose(getConfig(), …); });
 * });
 * ```
 */
export function useAgentVolumesTestConfig(): { getConfig: () => WrapperConfig } {
  let mockConfig: WrapperConfig;
  useTempWorkDir(
    baseConfig,
    (c) => {
      mockConfig = c;
    },
    () => mockConfig,
  );
  return { getConfig: () => mockConfig };
}
