import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyConfigOptionsInPlaceWithCliPrecedence,
  loadAwfFileConfig,
  mapAwfFileConfigToCliOptions,
  validateAwfFileConfig,
} from './config-file';

describe('config-file', () => {
  describe('validateAwfFileConfig', () => {
    it('accepts valid nested config sections', () => {
      const errors = validateAwfFileConfig({
        network: { allowDomains: ['github.com'] },
        apiProxy: { enabled: true, targets: { openai: { host: 'api.openai.com' } } },
        container: { agentTimeout: 30 },
      });

      expect(errors).toEqual([]);
    });

    it('reports unknown keys and invalid value types', () => {
      const errors = validateAwfFileConfig({
        network: { allowDomains: 'github.com' },
        unknown: true,
      });

      expect(errors).toContain('config.unknown is not supported');
      expect(errors).toContain('config.network.allowDomains must be an array of strings');
    });

    it('rejects unsupported copilot basePath', () => {
      const errors = validateAwfFileConfig({
        apiProxy: { targets: { copilot: { host: 'api.githubcopilot.com', basePath: '/v1' } } },
      });

      expect(errors).toContain('config.apiProxy.targets.copilot.basePath is not supported');
    });
  });

  describe('loadAwfFileConfig', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-config-file-test-'));
    });

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('loads JSON config files', () => {
      const filePath = path.join(testDir, 'awf.json');
      fs.writeFileSync(filePath, JSON.stringify({ logging: { logLevel: 'debug' } }));

      const result = loadAwfFileConfig(filePath);

      expect(result.logging?.logLevel).toBe('debug');
    });

    it('loads YAML config files', () => {
      const filePath = path.join(testDir, 'awf.yaml');
      fs.writeFileSync(filePath, 'network:\n  allowDomains:\n    - github.com\n');

      const result = loadAwfFileConfig(filePath);

      expect(result.network?.allowDomains).toEqual(['github.com']);
    });

    it('loads config from stdin when path is "-"', () => {
      const result = loadAwfFileConfig('-', () => '{"network":{"allowDomains":["github.com"]}}');

      expect(result.network?.allowDomains).toEqual(['github.com']);
    });

    it('throws helpful validation errors', () => {
      const filePath = path.join(testDir, 'awf.json');
      fs.writeFileSync(filePath, JSON.stringify({ container: { agentTimeout: -1 } }));

      expect(() => loadAwfFileConfig(filePath)).toThrow('config.container.agentTimeout must be a positive integer');
    });
  });

  describe('mapAwfFileConfigToCliOptions', () => {
    it('maps nested config values to CLI option names', () => {
      const result = mapAwfFileConfigToCliOptions({
        network: { allowDomains: ['github.com', 'api.github.com'], dnsServers: ['1.1.1.1', '1.0.0.1'] },
        apiProxy: { enabled: true, targets: { anthropic: { host: 'api.anthropic.com', basePath: '/anthropic' } } },
        container: { agentTimeout: 15, containerWorkDir: '/workspace' },
        rateLimiting: { enabled: false, requestsPerMinute: 60 },
      });

      expect(result.allowDomains).toBe('github.com,api.github.com');
      expect(result.dnsServers).toBe('1.1.1.1,1.0.0.1');
      expect(result.enableApiProxy).toBe(true);
      expect(result.anthropicApiTarget).toBe('api.anthropic.com');
      expect(result.anthropicApiBasePath).toBe('/anthropic');
      expect(result.agentTimeout).toBe('15');
      expect(result.containerWorkdir).toBe('/workspace');
      expect(result.rateLimit).toBe(false);
      expect(result.rateLimitRpm).toBe('60');
    });
  });

  describe('applyConfigOptionsInPlaceWithCliPrecedence', () => {
    it('does not overwrite explicitly provided CLI options', () => {
      const options: Record<string, unknown> = { logLevel: 'warn', memoryLimit: '4g' };
      const configOptions: Record<string, unknown> = { logLevel: 'debug', memoryLimit: '8g', imageTag: 'latest' };

      applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, (name) => name === 'logLevel');

      expect(options).toEqual({ logLevel: 'warn', memoryLimit: '8g', imageTag: 'latest' });
    });
  });
});
