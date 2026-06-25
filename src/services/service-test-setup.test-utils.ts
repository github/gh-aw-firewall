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
/**
 * Temporarily patches `process.env`, runs `fn`, then restores the original values.
 *
 * Pass `undefined` as the value for a key to delete it for the duration of the call.
 */
export function withEnv(envPatch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(envPatch)) {
    saved[key] = process.env[key];
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

export function useAgentVolumesTestConfig(): { getConfig: () => WrapperConfig } {
  let mockConfig: WrapperConfig | undefined;
  const getConfig = (): WrapperConfig => {
    if (!mockConfig) {
      throw new Error('Agent volumes test config is not initialized');
    }
    return mockConfig;
  };

  useTempWorkDir(
    baseConfig,
    (c) => {
      mockConfig = c;
    },
    getConfig,
  );
  return { getConfig };
}
