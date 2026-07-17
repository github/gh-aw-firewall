/**
 * Coverage tests for uncovered branches in compose-generator.ts:
 *   - buildLocal guard: throws when containers/ directory is missing (lines 30-32)
 *   - api-proxy port publishing + awf-ext network attachment for microVM mode (lines 144-158)
 */

// Must mock fs before imports so compose-generator picks up the mocked version
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
  resolveDockerHostGateway: jest.fn().mockReturnValue(null),
}));

import { generateDockerCompose } from './compose-generator';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';

const fsMock = fs as jest.Mocked<typeof fs>;

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-compose-gaps-'));
  fsMock.existsSync.mockImplementation(jest.requireActual<typeof import('fs')>('fs').existsSync);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  jest.clearAllMocks();
});

describe('compose-generator – buildLocal containers dir missing (lines 30-32)', () => {
  it('throws when buildLocal is true but containers/ directory does not exist', () => {
    fsMock.existsSync.mockReturnValue(false);

    const config = { ...baseConfig, workDir, buildLocal: true };
    expect(() => generateDockerCompose(config, mockNetworkConfig)).toThrow(
      '--build-local flag requires a full repository checkout'
    );
  });
});

describe('compose-generator – api-proxy port publishing in microVM mode (lines 144-158)', () => {
  const networkConfigWithProxy = {
    ...mockNetworkConfig,
    proxyIp: '172.30.0.30',
  };

  it('publishes api-proxy ports and attaches awf-ext when networkIsolation=true (sbx runtime)', () => {
    const config = {
      ...baseConfig,
      workDir,
      enableApiProxy: true,
      networkIsolation: true,
      containerRuntime: 'sbx', // sbx = microvm → includeAgent=false
    };

    const result = generateDockerCompose(config, networkConfigWithProxy);

    const apiProxy = result.services['api-proxy'];
    expect(apiProxy).toBeDefined();
    expect(Array.isArray(apiProxy.ports)).toBe(true);
    expect((apiProxy.ports as string[]).length).toBeGreaterThan(0);
    const networks = apiProxy.networks as Record<string, unknown>;
    expect(networks).toHaveProperty('awf-ext');
  });

  it('publishes api-proxy ports without awf-ext when networkIsolation=false (sbx runtime)', () => {
    const config = {
      ...baseConfig,
      workDir,
      enableApiProxy: true,
      networkIsolation: false,
      containerRuntime: 'sbx',
    };

    const result = generateDockerCompose(config, networkConfigWithProxy);

    const apiProxy = result.services['api-proxy'];
    expect(apiProxy).toBeDefined();
    expect(Array.isArray(apiProxy.ports)).toBe(true);
    const networks = apiProxy.networks as Record<string, unknown> | undefined;
    expect(networks?.['awf-ext']).toBeUndefined();
  });
});
