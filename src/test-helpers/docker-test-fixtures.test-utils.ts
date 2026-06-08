/**
 * Shared Docker test fixtures used across compose-generator and service unit tests.
 *
 * Note: `jest.mock('execa', ...)` along with the `mockExecaFn`/`mockExecaSync`
 * declarations must remain in each individual test file. Jest hoists jest.mock()
 * calls to the top of each file before imports are resolved, so the factory
 * closure cannot reference variables from an imported module.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

/**
 * Shared temporary directory lifecycle for cleanup-related unit tests.
 *
 * Creates a fresh `awf-*` temp dir before each test and removes it after.
 * An optional `resetMocks` callback (defaults to `jest.clearAllMocks()`) is
 * invoked in `beforeEach` immediately after the directory is created.
 *
 * @returns An object with a `getDir()` accessor for the current temp dir path.
 */
export function useCleanupTestDir(
  resetMocks: () => void = () => jest.clearAllMocks()
): { getDir: () => string } {
  let testDir: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-'));
    resetMocks();
  });

  afterEach(() => {
    /* istanbul ignore else */
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  return {
    getDir: () => {
      /* istanbul ignore next */
      if (!testDir) {
        throw new Error('Cleanup test directory is not initialized');
      }
      return testDir;
    },
  };
}

/**
 * General-purpose temporary directory lifecycle for unit tests.
 *
 * Creates a fresh temp dir (with the given prefix) before each test, calls
 * `jest.clearAllMocks()`, and removes the directory after each test.
 *
 * @param prefix - Directory name prefix passed to `fs.mkdtempSync`. Defaults to `'awf-test-'`.
 * @returns An object with a `getDir()` accessor for the current temp dir path.
 */
export function useTempDir(prefix = 'awf-test-'): { getDir: () => string } {
  let testDir: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    jest.clearAllMocks();
  });

  afterEach(() => {
    /* istanbul ignore else */
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  return {
    getDir: () => {
      /* istanbul ignore next */
      if (!testDir) {
        throw new Error('Temp test directory is not initialized');
      }
      return testDir;
    },
  };
}

/**
 * Shared temporary workDir lifecycle for Docker-related unit tests.
 */
export function useTempWorkDir(
  fixtureConfig: Omit<WrapperConfig, 'workDir'>,
  setConfig: (config: WrapperConfig) => void,
  getConfig: () => WrapperConfig
): void {
  beforeEach(() => {
    setConfig({
      ...fixtureConfig,
      workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')),
    });
  });

  afterEach(() => {
    fs.rmSync(getConfig().workDir, { recursive: true, force: true });
  });
}
