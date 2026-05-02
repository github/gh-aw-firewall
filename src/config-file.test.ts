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

    it('rejects non-object config root', () => {
      expect(validateAwfFileConfig(null)).toEqual(['config root must be an object']);
      expect(validateAwfFileConfig('string')).toEqual(['config root must be an object']);
      expect(validateAwfFileConfig(42)).toEqual(['config root must be an object']);
      expect(validateAwfFileConfig([])).toEqual(['config root must be an object']);
    });

    it('rejects non-string $schema', () => {
      const errors = validateAwfFileConfig({ $schema: 123 });
      expect(errors).toContain('config.$schema must be a string');
    });

    it('rejects non-object network', () => {
      const errors = validateAwfFileConfig({ network: 'invalid' });
      expect(errors).toContain('config.network must be an object');
    });

    it('rejects non-string network.upstreamProxy', () => {
      const errors = validateAwfFileConfig({ network: { upstreamProxy: 123 } });
      expect(errors).toContain('config.network.upstreamProxy must be a string');
    });

    it('rejects non-string-array network.blockDomains', () => {
      const errors = validateAwfFileConfig({ network: { blockDomains: [1, 2, 3] } });
      expect(errors).toContain('config.network.blockDomains must be an array of strings');
    });

    it('rejects non-string-array network.dnsServers', () => {
      const errors = validateAwfFileConfig({ network: { dnsServers: 'not-array' } });
      expect(errors).toContain('config.network.dnsServers must be an array of strings');
    });

    it('rejects non-object apiProxy', () => {
      const errors = validateAwfFileConfig({ apiProxy: 'invalid' });
      expect(errors).toContain('config.apiProxy must be an object');
    });

    it('rejects non-boolean apiProxy.enabled', () => {
      const errors = validateAwfFileConfig({ apiProxy: { enabled: 'yes' } });
      expect(errors).toContain('config.apiProxy.enabled must be a boolean');
    });

    it('accepts boolean apiProxy.enableOpenCode', () => {
      expect(validateAwfFileConfig({ apiProxy: { enableOpenCode: true } })).toEqual([]);
      expect(validateAwfFileConfig({ apiProxy: { enableOpenCode: false } })).toEqual([]);
    });

    it('rejects non-boolean apiProxy.enableOpenCode', () => {
      const errors = validateAwfFileConfig({ apiProxy: { enableOpenCode: 'yes' } });
      expect(errors).toContain('config.apiProxy.enableOpenCode must be a boolean');
    });

    it('accepts boolean apiProxy.anthropicAutoCache', () => {
      expect(validateAwfFileConfig({ apiProxy: { anthropicAutoCache: true } })).toEqual([]);
      expect(validateAwfFileConfig({ apiProxy: { anthropicAutoCache: false } })).toEqual([]);
    });

    it('rejects non-boolean apiProxy.anthropicAutoCache', () => {
      const errors = validateAwfFileConfig({ apiProxy: { anthropicAutoCache: 'yes' } });
      expect(errors).toContain('config.apiProxy.anthropicAutoCache must be a boolean');
    });

    it('accepts valid apiProxy.anthropicCacheTailTtl values', () => {
      expect(validateAwfFileConfig({ apiProxy: { anthropicCacheTailTtl: '5m' } })).toEqual([]);
      expect(validateAwfFileConfig({ apiProxy: { anthropicCacheTailTtl: '1h' } })).toEqual([]);
    });

    it('rejects invalid apiProxy.anthropicCacheTailTtl', () => {
      const errors = validateAwfFileConfig({ apiProxy: { anthropicCacheTailTtl: '10m' } });
      expect(errors).toContain('config.apiProxy.anthropicCacheTailTtl must be one of: 5m, 1h');
    });

    it('rejects non-object apiProxy.targets', () => {
      const errors = validateAwfFileConfig({ apiProxy: { targets: 'invalid' } });
      expect(errors).toContain('config.apiProxy.targets must be an object');
    });

    it('rejects non-object provider target', () => {
      const errors = validateAwfFileConfig({ apiProxy: { targets: { openai: 'invalid' } } });
      expect(errors).toContain('config.apiProxy.targets.openai must be an object');
    });

    it('rejects non-string provider target host', () => {
      const errors = validateAwfFileConfig({ apiProxy: { targets: { openai: { host: 123 } } } });
      expect(errors).toContain('config.apiProxy.targets.openai.host must be a string');
    });

    it('rejects non-string provider target basePath', () => {
      const errors = validateAwfFileConfig({ apiProxy: { targets: { anthropic: { basePath: 456 } } } });
      expect(errors).toContain('config.apiProxy.targets.anthropic.basePath must be a string');
    });

    it('accepts gemini target with host and basePath', () => {
      const errors = validateAwfFileConfig({
        apiProxy: { targets: { gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1' } } },
      });
      expect(errors).toEqual([]);
    });

    it('rejects non-object security', () => {
      const errors = validateAwfFileConfig({ security: 'invalid' });
      expect(errors).toContain('config.security must be an object');
    });

    it('rejects non-boolean security.sslBump', () => {
      const errors = validateAwfFileConfig({ security: { sslBump: 'yes' } });
      expect(errors).toContain('config.security.sslBump must be a boolean');
    });

    it('rejects non-boolean security.enableDlp', () => {
      const errors = validateAwfFileConfig({ security: { enableDlp: 1 } });
      expect(errors).toContain('config.security.enableDlp must be a boolean');
    });

    it('rejects non-boolean security.enableHostAccess', () => {
      const errors = validateAwfFileConfig({ security: { enableHostAccess: 'true' } });
      expect(errors).toContain('config.security.enableHostAccess must be a boolean');
    });

    it('rejects non-string/array security.allowHostPorts', () => {
      const errors = validateAwfFileConfig({ security: { allowHostPorts: 8080 } });
      expect(errors).toContain('config.security.allowHostPorts must be a string or array of strings');
    });

    it('accepts security.allowHostPorts as string', () => {
      const errors = validateAwfFileConfig({ security: { allowHostPorts: '8080' } });
      expect(errors).toEqual([]);
    });

    it('accepts security.allowHostPorts as string array', () => {
      const errors = validateAwfFileConfig({ security: { allowHostPorts: ['8080', '9090'] } });
      expect(errors).toEqual([]);
    });

    it('rejects non-string/array security.allowHostServicePorts', () => {
      const errors = validateAwfFileConfig({ security: { allowHostServicePorts: 9090 } });
      expect(errors).toContain('config.security.allowHostServicePorts must be a string or array of strings');
    });

    it('rejects non-object security.difcProxy', () => {
      const errors = validateAwfFileConfig({ security: { difcProxy: 'invalid' } });
      expect(errors).toContain('config.security.difcProxy must be an object');
    });

    it('rejects non-string security.difcProxy.host', () => {
      const errors = validateAwfFileConfig({ security: { difcProxy: { host: 123 } } });
      expect(errors).toContain('config.security.difcProxy.host must be a string');
    });

    it('rejects non-string security.difcProxy.caCert', () => {
      const errors = validateAwfFileConfig({ security: { difcProxy: { caCert: 456 } } });
      expect(errors).toContain('config.security.difcProxy.caCert must be a string');
    });

    it('rejects unknown security.difcProxy keys', () => {
      const errors = validateAwfFileConfig({ security: { difcProxy: { host: 'proxy.example.com', unknown: true } } });
      expect(errors).toContain('config.security.difcProxy.unknown is not supported');
    });

    it('rejects non-object container', () => {
      const errors = validateAwfFileConfig({ container: 'invalid' });
      expect(errors).toContain('config.container must be an object');
    });

    it('rejects non-string container.memoryLimit', () => {
      const errors = validateAwfFileConfig({ container: { memoryLimit: 512 } });
      expect(errors).toContain('config.container.memoryLimit must be a string');
    });

    it('rejects non-positive-integer container.agentTimeout', () => {
      expect(validateAwfFileConfig({ container: { agentTimeout: 0 } })).toContain('config.container.agentTimeout must be a positive integer');
      expect(validateAwfFileConfig({ container: { agentTimeout: -1 } })).toContain('config.container.agentTimeout must be a positive integer');
      expect(validateAwfFileConfig({ container: { agentTimeout: 1.5 } })).toContain('config.container.agentTimeout must be a positive integer');
      expect(validateAwfFileConfig({ container: { agentTimeout: 'five' } })).toContain('config.container.agentTimeout must be a positive integer');
    });

    it('rejects non-boolean container.enableDind', () => {
      const errors = validateAwfFileConfig({ container: { enableDind: 1 } });
      expect(errors).toContain('config.container.enableDind must be a boolean');
    });

    it('rejects non-string container.workDir', () => {
      const errors = validateAwfFileConfig({ container: { workDir: 123 } });
      expect(errors).toContain('config.container.workDir must be a string');
    });

    it('rejects non-string container.containerWorkDir', () => {
      const errors = validateAwfFileConfig({ container: { containerWorkDir: 123 } });
      expect(errors).toContain('config.container.containerWorkDir must be a string');
    });

    it('rejects non-string container.imageRegistry', () => {
      const errors = validateAwfFileConfig({ container: { imageRegistry: 123 } });
      expect(errors).toContain('config.container.imageRegistry must be a string');
    });

    it('rejects non-string container.imageTag', () => {
      const errors = validateAwfFileConfig({ container: { imageTag: 123 } });
      expect(errors).toContain('config.container.imageTag must be a string');
    });

    it('rejects non-boolean container.skipPull', () => {
      const errors = validateAwfFileConfig({ container: { skipPull: 'yes' } });
      expect(errors).toContain('config.container.skipPull must be a boolean');
    });

    it('rejects non-boolean container.buildLocal', () => {
      const errors = validateAwfFileConfig({ container: { buildLocal: 'yes' } });
      expect(errors).toContain('config.container.buildLocal must be a boolean');
    });

    it('rejects non-string container.agentImage', () => {
      const errors = validateAwfFileConfig({ container: { agentImage: 123 } });
      expect(errors).toContain('config.container.agentImage must be a string');
    });

    it('rejects non-boolean container.tty', () => {
      const errors = validateAwfFileConfig({ container: { tty: 'yes' } });
      expect(errors).toContain('config.container.tty must be a boolean');
    });

    it('rejects non-string container.dockerHost', () => {
      const errors = validateAwfFileConfig({ container: { dockerHost: 123 } });
      expect(errors).toContain('config.container.dockerHost must be a string');
    });

    it('rejects unknown container keys', () => {
      const errors = validateAwfFileConfig({ container: { unknown: true } });
      expect(errors).toContain('config.container.unknown is not supported');
    });

    it('rejects non-object environment', () => {
      const errors = validateAwfFileConfig({ environment: 'invalid' });
      expect(errors).toContain('config.environment must be an object');
    });

    it('rejects non-string environment.envFile', () => {
      const errors = validateAwfFileConfig({ environment: { envFile: 123 } });
      expect(errors).toContain('config.environment.envFile must be a string');
    });

    it('rejects non-boolean environment.envAll', () => {
      const errors = validateAwfFileConfig({ environment: { envAll: 'yes' } });
      expect(errors).toContain('config.environment.envAll must be a boolean');
    });

    it('rejects non-string-array environment.excludeEnv', () => {
      const errors = validateAwfFileConfig({ environment: { excludeEnv: 'HOME' } });
      expect(errors).toContain('config.environment.excludeEnv must be an array of strings');
    });

    it('rejects unknown environment keys', () => {
      const errors = validateAwfFileConfig({ environment: { unknown: true } });
      expect(errors).toContain('config.environment.unknown is not supported');
    });

    it('rejects non-object logging', () => {
      const errors = validateAwfFileConfig({ logging: 'invalid' });
      expect(errors).toContain('config.logging must be an object');
    });

    it('rejects invalid logging.logLevel', () => {
      const errors = validateAwfFileConfig({ logging: { logLevel: 'verbose' } });
      expect(errors).toContain('config.logging.logLevel must be one of: debug, info, warn, error');
    });

    it('rejects non-string logging.logLevel type', () => {
      const errors = validateAwfFileConfig({ logging: { logLevel: 42 } });
      expect(errors).toContain('config.logging.logLevel must be one of: debug, info, warn, error');
    });

    it('accepts valid logging.logLevel values', () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        expect(validateAwfFileConfig({ logging: { logLevel: level } })).toEqual([]);
      }
    });

    it('rejects non-boolean logging.diagnosticLogs', () => {
      const errors = validateAwfFileConfig({ logging: { diagnosticLogs: 'yes' } });
      expect(errors).toContain('config.logging.diagnosticLogs must be a boolean');
    });

    it('rejects non-string logging.auditDir', () => {
      const errors = validateAwfFileConfig({ logging: { auditDir: 123 } });
      expect(errors).toContain('config.logging.auditDir must be a string');
    });

    it('rejects non-string logging.proxyLogsDir', () => {
      const errors = validateAwfFileConfig({ logging: { proxyLogsDir: 123 } });
      expect(errors).toContain('config.logging.proxyLogsDir must be a string');
    });

    it('rejects non-string logging.sessionStateDir', () => {
      const errors = validateAwfFileConfig({ logging: { sessionStateDir: 123 } });
      expect(errors).toContain('config.logging.sessionStateDir must be a string');
    });

    it('rejects non-object rateLimiting', () => {
      const errors = validateAwfFileConfig({ rateLimiting: 'invalid' });
      expect(errors).toContain('config.rateLimiting must be an object');
    });

    it('rejects non-boolean rateLimiting.enabled', () => {
      const errors = validateAwfFileConfig({ rateLimiting: { enabled: 'yes' } });
      expect(errors).toContain('config.rateLimiting.enabled must be a boolean');
    });

    it('rejects non-positive-integer rateLimiting.requestsPerMinute', () => {
      const errors = validateAwfFileConfig({ rateLimiting: { requestsPerMinute: -5 } });
      expect(errors).toContain('config.rateLimiting.requestsPerMinute must be a positive integer');
    });

    it('rejects non-positive-integer rateLimiting.requestsPerHour', () => {
      const errors = validateAwfFileConfig({ rateLimiting: { requestsPerHour: 0 } });
      expect(errors).toContain('config.rateLimiting.requestsPerHour must be a positive integer');
    });

    it('rejects non-positive-integer rateLimiting.bytesPerMinute', () => {
      const errors = validateAwfFileConfig({ rateLimiting: { bytesPerMinute: 'lots' } });
      expect(errors).toContain('config.rateLimiting.bytesPerMinute must be a positive integer');
    });

    it('accepts valid rateLimiting values', () => {
      const errors = validateAwfFileConfig({
        rateLimiting: { enabled: true, requestsPerMinute: 60, requestsPerHour: 3600, bytesPerMinute: 1048576 },
      });
      expect(errors).toEqual([]);
    });

    it('accepts valid security config', () => {
      const errors = validateAwfFileConfig({
        security: {
          sslBump: true,
          enableDlp: false,
          enableHostAccess: true,
          allowHostPorts: '8080',
          allowHostServicePorts: ['5432', '6379'],
          difcProxy: { host: 'proxy.example.com', caCert: '/path/to/ca.crt' },
        },
      });
      expect(errors).toEqual([]);
    });

    it('accepts empty config object', () => {
      expect(validateAwfFileConfig({})).toEqual([]);
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

    it('loads YML config files', () => {
      const filePath = path.join(testDir, 'awf.yml');
      fs.writeFileSync(filePath, 'logging:\n  logLevel: warn\n');

      const result = loadAwfFileConfig(filePath);

      expect(result.logging?.logLevel).toBe('warn');
    });

    it('loads config from stdin when path is "-"', () => {
      const result = loadAwfFileConfig('-', () => '{"network":{"allowDomains":["github.com"]}}');

      expect(result.network?.allowDomains).toEqual(['github.com']);
    });

    it('loads YAML from stdin when JSON parse fails', () => {
      const yamlContent = 'network:\n  allowDomains:\n    - example.com\n';
      const result = loadAwfFileConfig('-', () => yamlContent);

      expect(result.network?.allowDomains).toEqual(['example.com']);
    });

    it('loads extensionless config file as JSON', () => {
      const filePath = path.join(testDir, 'awfconfig');
      fs.writeFileSync(filePath, JSON.stringify({ logging: { logLevel: 'error' } }));

      const result = loadAwfFileConfig(filePath);

      expect(result.logging?.logLevel).toBe('error');
    });

    it('loads extensionless config file as YAML when JSON fails', () => {
      const filePath = path.join(testDir, 'awfconfig');
      fs.writeFileSync(filePath, 'logging:\n  logLevel: info\n');

      const result = loadAwfFileConfig(filePath);

      expect(result.logging?.logLevel).toBe('info');
    });

    it('throws helpful validation errors', () => {
      const filePath = path.join(testDir, 'awf.json');
      fs.writeFileSync(filePath, JSON.stringify({ container: { agentTimeout: -1 } }));

      expect(() => loadAwfFileConfig(filePath)).toThrow('config.container.agentTimeout must be a positive integer');
    });

    it('throws on invalid JSON file', () => {
      const filePath = path.join(testDir, 'awf.json');
      fs.writeFileSync(filePath, '{invalid json}');

      expect(() => loadAwfFileConfig(filePath)).toThrow('Failed to parse AWF config from');
    });

    it('throws on invalid YAML file', () => {
      const filePath = path.join(testDir, 'awf.yaml');
      // Intentionally malformed YAML to exercise parse-error handling
      fs.writeFileSync(filePath, ': invalid yaml\n  bad indent:\n');

      // May throw on parse or validation
      expect(() => loadAwfFileConfig(filePath)).toThrow();
    });

    it('includes path in validation error message', () => {
      const filePath = path.join(testDir, 'awf.json');
      fs.writeFileSync(filePath, JSON.stringify({ unknown: true }));

      expect(() => loadAwfFileConfig(filePath)).toThrow(`Invalid AWF config at ${filePath}`);
    });

    it('includes "stdin" in validation error message for stdin input', () => {
      expect(() => loadAwfFileConfig('-', () => '{"unknown": true}')).toThrow('Invalid AWF config at stdin');
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

    it('returns undefined for unset optional fields', () => {
      const result = mapAwfFileConfigToCliOptions({});

      expect(result.allowDomains).toBeUndefined();
      expect(result.blockDomains).toBeUndefined();
      expect(result.dnsServers).toBeUndefined();
      expect(result.upstreamProxy).toBeUndefined();
      expect(result.enableApiProxy).toBeUndefined();
      expect(result.sslBump).toBeUndefined();
      expect(result.rateLimit).toBeUndefined();
    });

    it('maps all API proxy target fields', () => {
      const result = mapAwfFileConfigToCliOptions({
        apiProxy: {
          enableOpenCode: true,
          targets: {
            openai: { host: 'api.openai.com', basePath: '/v1' },
            copilot: { host: 'api.githubcopilot.com' },
            gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1beta' },
          },
        },
      });

      expect(result.enableOpencode).toBe(true);
      expect(result.openaiApiTarget).toBe('api.openai.com');
      expect(result.openaiApiBasePath).toBe('/v1');
      expect(result.copilotApiTarget).toBe('api.githubcopilot.com');
      expect(result.geminiApiTarget).toBe('generativelanguage.googleapis.com');
      expect(result.geminiApiBasePath).toBe('/v1beta');
    });

    it('maps anthropicAutoCache and anthropicCacheTailTtl fields', () => {
      const result = mapAwfFileConfigToCliOptions({
        apiProxy: {
          anthropicAutoCache: true,
          anthropicCacheTailTtl: '1h',
        },
      });
      expect(result.anthropicAutoCache).toBe(true);
      expect(result.anthropicCacheTailTtl).toBe('1h');
    });

    it('leaves anthropicAutoCache and anthropicCacheTailTtl undefined when not set', () => {
      const result = mapAwfFileConfigToCliOptions({});
      expect(result.anthropicAutoCache).toBeUndefined();
      expect(result.anthropicCacheTailTtl).toBeUndefined();
    });

    it('maps security fields', () => {
      const result = mapAwfFileConfigToCliOptions({
        security: {
          sslBump: true,
          enableDlp: false,
          enableHostAccess: true,
          allowHostPorts: ['8080', '9090'],
          allowHostServicePorts: '5432',
          difcProxy: { host: 'proxy.example.com', caCert: '/path/ca.crt' },
        },
      });

      expect(result.sslBump).toBe(true);
      expect(result.enableDlp).toBe(false);
      expect(result.enableHostAccess).toBe(true);
      expect(result.allowHostPorts).toBe('8080,9090');
      expect(result.allowHostServicePorts).toBe('5432');
      expect(result.difcProxyHost).toBe('proxy.example.com');
      expect(result.difcProxyCaCert).toBe('/path/ca.crt');
    });

    it('maps container fields', () => {
      const result = mapAwfFileConfigToCliOptions({
        container: {
          memoryLimit: '4g',
          enableDind: true,
          workDir: '/tmp/awf',
          imageRegistry: 'ghcr.io/custom',
          imageTag: 'v1.0',
          skipPull: true,
          buildLocal: false,
          agentImage: 'custom:latest',
          tty: true,
          dockerHost: 'unix:///var/run/docker.sock',
        },
      });

      expect(result.memoryLimit).toBe('4g');
      expect(result.enableDind).toBe(true);
      expect(result.workDir).toBe('/tmp/awf');
      expect(result.imageRegistry).toBe('ghcr.io/custom');
      expect(result.imageTag).toBe('v1.0');
      expect(result.skipPull).toBe(true);
      expect(result.buildLocal).toBe(false);
      expect(result.agentImage).toBe('custom:latest');
      expect(result.tty).toBe(true);
      expect(result.dockerHost).toBe('unix:///var/run/docker.sock');
    });

    it('maps environment fields', () => {
      const result = mapAwfFileConfigToCliOptions({
        environment: {
          envFile: '.env',
          envAll: true,
          excludeEnv: ['HOME', 'PATH'],
        },
      });

      expect(result.envFile).toBe('.env');
      expect(result.envAll).toBe(true);
      expect(result.excludeEnv).toEqual(['HOME', 'PATH']);
    });

    it('maps logging fields', () => {
      const result = mapAwfFileConfigToCliOptions({
        logging: {
          logLevel: 'debug',
          diagnosticLogs: true,
          auditDir: '/tmp/audit',
          proxyLogsDir: '/tmp/proxy',
          sessionStateDir: '/tmp/state',
        },
      });

      expect(result.logLevel).toBe('debug');
      expect(result.diagnosticLogs).toBe(true);
      expect(result.auditDir).toBe('/tmp/audit');
      expect(result.proxyLogsDir).toBe('/tmp/proxy');
      expect(result.sessionStateDir).toBe('/tmp/state');
    });

    it('maps rateLimiting fields including rph and bytesPm', () => {
      const result = mapAwfFileConfigToCliOptions({
        rateLimiting: { enabled: true, requestsPerHour: 3600, bytesPerMinute: 1048576 },
      });

      expect(result.rateLimit).toBeUndefined(); // enabled: true → no negated flag
      expect(result.rateLimitRph).toBe('3600');
      expect(result.rateLimitBytesPm).toBe('1048576');
    });

    it('returns undefined for empty allowDomains array', () => {
      const result = mapAwfFileConfigToCliOptions({ network: { allowDomains: [] } });
      expect(result.allowDomains).toBeUndefined();
    });
  });

  describe('applyConfigOptionsInPlaceWithCliPrecedence', () => {
    it('does not overwrite explicitly provided CLI options', () => {
      const options: Record<string, unknown> = { logLevel: 'warn', memoryLimit: '4g' };
      const configOptions: Record<string, unknown> = { logLevel: 'debug', memoryLimit: '8g', imageTag: 'latest' };

      applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, (name) => name === 'logLevel');

      expect(options).toEqual({ logLevel: 'warn', memoryLimit: '8g', imageTag: 'latest' });
    });

    it('applies all config options when no CLI options provided', () => {
      const options: Record<string, unknown> = {};
      const configOptions: Record<string, unknown> = { logLevel: 'debug', imageTag: 'latest', allowDomains: 'github.com' };

      applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, () => false);

      expect(options).toEqual({ logLevel: 'debug', imageTag: 'latest', allowDomains: 'github.com' });
    });

    it('skips undefined config values', () => {
      const options: Record<string, unknown> = {};
      const configOptions: Record<string, unknown> = { logLevel: undefined, imageTag: 'latest' };

      applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, () => false);

      expect(options).toEqual({ imageTag: 'latest' });
      expect('logLevel' in options).toBe(false);
    });

    it('overwrites existing options when CLI did not provide them', () => {
      const options: Record<string, unknown> = { logLevel: 'info' };
      const configOptions: Record<string, unknown> = { logLevel: 'error' };

      applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, () => false);

      expect(options.logLevel).toBe('error');
    });
  });
});
