/**
 * Shared temp-dir fixture for compose-generator test suites.
 *
 * Each compose-generator suite needs the same bootstrap: a fresh WrapperConfig
 * derived from `baseConfig` with a per-test temp workDir, removed again after
 * the test. This helper registers that beforeEach/afterEach pair so the
 * boilerplate is not repeated (and cannot drift) across suites.
 *
 * The `jest.mock('execa', …)` registration must stay in each test file because
 * jest.mock() calls are hoisted above imports.
 *
 * Usage:
 *   const fixture = setupComposeTestFixture();
 *   ...
 *   generateDockerCompose(fixture.withConfig({ containerRuntime: 'gvisor' }), net);
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { baseConfig } from './docker-test-fixtures.test-utils';
import type { WrapperConfig } from '../types';

export interface ComposeTestFixture {
  /** The current test's config, with a freshly created temp workDir. */
  readonly config: WrapperConfig;
  /** The current test's config merged with per-test overrides. */
  withConfig(overrides: Partial<WrapperConfig>): WrapperConfig;
}

/**
 * Registers the beforeEach/afterEach lifecycle for a compose-generator suite
 * and returns an accessor for the config created for the running test.
 */
export function setupComposeTestFixture(prefix = 'awf-test-'): ComposeTestFixture {
  let current: WrapperConfig | undefined;

  beforeEach(() => {
    current = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)) };
  });

  afterEach(() => {
    if (current) {
      fs.rmSync(current.workDir, { recursive: true, force: true });
      current = undefined;
    }
  });

  const readConfig = (): WrapperConfig => {
    if (!current) {
      throw new Error('setupComposeTestFixture: config is only available inside a test');
    }
    return current;
  };

  return {
    get config(): WrapperConfig {
      return readConfig();
    },
    withConfig(overrides: Partial<WrapperConfig>): WrapperConfig {
      return { ...readConfig(), ...overrides };
    },
  };
}
