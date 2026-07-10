/**
 * Tests the buildLocal + missing containers dir branch (line 29) in compose-generator.ts.
 *
 * This file must be separate because it needs a module-level jest.mock('fs') to
 * make existsSync configurable, which conflicts with tests that need real fs.
 */

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

jest.mock('./services/host-gateway', () => ({
  resolveDockerHostGateway: jest.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateDockerCompose } from './compose-generator';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import type { WrapperConfig } from './types';

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

describe('generateDockerCompose — buildLocal with missing containers dir (line 29)', () => {
  let mockConfig: WrapperConfig;
  const actualExistsSync = jest.requireActual<typeof fs>('fs').existsSync;

  beforeEach(() => {
    mockConfig = {
      ...baseConfig,
      workDir: jest.requireActual<typeof os>('os').tmpdir() + '/awf-buildlocal-test-' + Date.now(),
    };
    // Default: behave like real fs
    mockExistsSync.mockImplementation(actualExistsSync);
  });

  it('throws when buildLocal=true and the containers directory is absent', () => {
    // Override existsSync so the containers dir check returns false
    mockExistsSync.mockImplementation((p) => {
      if (typeof p === 'string' && path.basename(p) === 'containers') {
        return false;
      }
      return actualExistsSync(p);
    });

    expect(() =>
      generateDockerCompose({ ...mockConfig, buildLocal: true }, mockNetworkConfig)
    ).toThrow(/--build-local flag requires a full repository checkout/);
  });

  it('does not throw when buildLocal=true and the containers directory exists', () => {
    // Ensure containers dir is found (real behaviour)
    mockExistsSync.mockImplementation(actualExistsSync);

    // Create a real workDir so generateDockerCompose can operate
    const realWorkDir = jest.requireActual<typeof fs>('fs').mkdtempSync(
      jest.requireActual<typeof path>('path').join(jest.requireActual<typeof os>('os').tmpdir(), 'awf-test-')
    );
    try {
      const result = generateDockerCompose({ ...mockConfig, workDir: realWorkDir, buildLocal: true }, mockNetworkConfig);
      expect(result.services['squid-proxy']).toBeDefined();
    } finally {
      jest.requireActual<typeof fs>('fs').rmSync(realWorkDir, { recursive: true, force: true });
    }
  });
});
