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

describe('DNS-over-HTTPS proxy sidecar', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

      const mockNetworkConfigWithDoh = {
        ...mockNetworkConfig,
        dohProxyIp: '172.30.0.40',
      };

      it('should not include doh-proxy service when dnsOverHttps is not set', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfigWithDoh);
        expect(result.services['doh-proxy']).toBeUndefined();
      });

      it('should include doh-proxy service when dnsOverHttps is set', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        expect(result.services['doh-proxy']).toBeDefined();
        const doh = result.services['doh-proxy'];
        expect(doh.container_name).toBe('awf-doh-proxy');
        expect(doh.image).toBe('cloudflare/cloudflared:latest');
      });

      it('should assign correct IP address to doh-proxy', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect((doh.networks as any)['awf-net'].ipv4_address).toBe('172.30.0.40');
      });

      it('should pass the resolver URL in the command', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://cloudflare-dns.com/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.command).toEqual(['proxy-dns', '--address', '0.0.0.0', '--port', '53', '--upstream', 'https://cloudflare-dns.com/dns-query']);
      });

      it('should configure healthcheck for doh-proxy', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.healthcheck).toBeDefined();
        expect(doh.healthcheck!.test).toEqual(['CMD', 'nslookup', '-port=53', 'cloudflare.com', '127.0.0.1']);
      });

      it('should drop all capabilities', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.cap_drop).toEqual(['ALL']);
        expect(doh.security_opt).toContain('no-new-privileges:true');
      });

      it('should set resource limits', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const doh = result.services['doh-proxy'];
        expect(doh.mem_limit).toBe('128m');
        expect(doh.memswap_limit).toBe('128m');
        expect(doh.pids_limit).toBe(50);
      });

      it('should update agent depends_on to wait for doh-proxy', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        const dependsOn = agent.depends_on as { [key: string]: { condition: string } };
        expect(dependsOn['doh-proxy']).toBeDefined();
        expect(dependsOn['doh-proxy'].condition).toBe('service_healthy');
      });

      it('should set agent DNS to DoH proxy IP when DoH is enabled', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        expect(agent.dns).toEqual(['172.30.0.40', '127.0.0.11']);
      });

      it('should set AWF_DOH_ENABLED and AWF_DOH_PROXY_IP environment variables', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_DOH_ENABLED).toBe('true');
        expect(env.AWF_DOH_PROXY_IP).toBe('172.30.0.40');
      });

      it('should not set DoH environment variables when dnsOverHttps is not set', () => {
        const result = generateDockerCompose(mockConfig, mockNetworkConfigWithDoh);
        const agent = result.services.agent;
        const env = agent.environment as Record<string, string>;
        expect(env.AWF_DOH_ENABLED).toBeUndefined();
        expect(env.AWF_DOH_PROXY_IP).toBeUndefined();
      });

      it('should not include doh-proxy when dohProxyIp is missing from networkConfig', () => {
        const configWithDoh = { ...mockConfig, dnsOverHttps: 'https://dns.google/dns-query' };
        const result = generateDockerCompose(configWithDoh, mockNetworkConfig);
        expect(result.services['doh-proxy']).toBeUndefined();
      });
});
