import { generateDockerCompose } from '../compose-generator';
import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('squid service', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

    it('should configure squid container correctly', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'];

      expect(squid.container_name).toBe('awf-squid');
      // squid.conf is NOT bind-mounted; it's injected via AWF_SQUID_CONFIG_B64 env var
      expect(squid.volumes).not.toContainEqual(expect.stringContaining('squid.conf'));
      expect(squid.volumes).toContain(`${mockConfig.workDir}/squid-logs:/var/log/squid:rw`);
      expect(squid.healthcheck).toBeDefined();
      expect(squid.ports).toContain('3128:3128');
    });

    it('should set stop_grace_period on squid service', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'] as any;
      expect(squid.stop_grace_period).toBe('2s');
    });

    it('should inject squid config via base64 env var when content is provided', () => {
      const squidConfig = 'http_port 3128\nacl allowed_domains dstdomain .github.com\n';
      const result = generateDockerCompose(mockConfig, mockNetworkConfig, undefined, squidConfig);
      const squid = result.services['squid-proxy'] as any;

      // Should have AWF_SQUID_CONFIG_B64 env var with base64-encoded config
      expect(squid.environment.AWF_SQUID_CONFIG_B64).toBe(
        Buffer.from(squidConfig).toString('base64')
      );

      // Should override entrypoint to decode config before starting squid
      expect(squid.entrypoint).toBeDefined();
      expect(squid.entrypoint[2]).toContain('base64 -d > /etc/squid/squid.conf');
      expect(squid.entrypoint[2]).toContain('entrypoint.sh');
    });
});
