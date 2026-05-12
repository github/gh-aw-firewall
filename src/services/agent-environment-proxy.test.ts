import { generateDockerCompose } from '../compose-generator';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent environment: proxy settings', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

  it('should configure agent container with proxy settings', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    expect(env.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(env.HTTPS_PROXY).toBe('http://172.30.0.10:3128');
    expect(env.https_proxy).toBe('http://172.30.0.10:3128');
    expect(env.SQUID_PROXY_HOST).toBe('squid-proxy');
    expect(env.SQUID_PROXY_PORT).toBe('3128');
  });

  it('should set lowercase https_proxy for Yarn 4 and Corepack compatibility', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    // Yarn 4 (undici), Corepack, and some Node.js HTTP clients only check lowercase
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    // http_proxy is intentionally NOT set - see comment in docker-manager.ts
    expect(env.http_proxy).toBeUndefined();
  });

  it('should set NODE_EXTRA_CA_CERTS when SSL Bump is enabled', () => {
    const sslBumpConfig = { ...mockConfig, sslBump: true };
    const ssl = {
      caFiles: {
        certPath: `${mockConfig.workDir}/ssl/ca-cert.pem`,
        keyPath: `${mockConfig.workDir}/ssl/ca-key.pem`,
        derPath: `${mockConfig.workDir}/ssl/ca-cert.der`,
      },
      sslDbPath: `${mockConfig.workDir}/ssl_db`,
    };
    const result = generateDockerCompose(sslBumpConfig, mockNetworkConfig, ssl);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    expect(env.NODE_EXTRA_CA_CERTS).toBe('/usr/local/share/ca-certificates/awf-ca.crt');
    expect(env.AWF_SSL_BUMP_ENABLED).toBe('true');
  });

  it('should not set NODE_EXTRA_CA_CERTS when SSL Bump is disabled', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.AWF_SSL_BUMP_ENABLED).toBeUndefined();
  });
});
