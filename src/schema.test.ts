import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';

const schemaPath = path.join(__dirname, '..', 'docs', 'awf-config.schema.json');

describe('awf-config.schema.json', () => {
  let schema: Record<string, unknown>;
  let validate: ReturnType<Ajv2020['compile']>;

  beforeAll(() => {
    const raw = fs.readFileSync(schemaPath, 'utf8');
    schema = JSON.parse(raw) as Record<string, unknown>;
    const ajv = new Ajv2020();
    validate = ajv.compile(schema);
  });

  it('is valid JSON and compiles without errors', () => {
    expect(schema).toBeDefined();
    expect(validate).toBeDefined();
  });

  it('has expected top-level metadata', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
  });

  it('covers all AwfFileConfig top-level fields', () => {
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining([
        '$schema',
        'network',
        'apiProxy',
        'security',
        'container',
        'environment',
        'logging',
        'rateLimiting',
      ])
    );
  });

  it('accepts an empty config', () => {
    expect(validate({})).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('accepts a full valid config', () => {
    const valid = {
      $schema: 'https://github.com/github/gh-aw-firewall/releases/latest/download/awf-config.schema.json',
      network: {
        allowDomains: ['github.com', 'api.openai.com'],
        blockDomains: ['malicious.example.com'],
        dnsServers: ['8.8.8.8', '8.8.4.4'],
        upstreamProxy: 'http://proxy.corp.example.com:8080',
      },
      apiProxy: {
        enabled: true,
        enableOpenCode: false,
        anthropicAutoCache: true,
        anthropicCacheTailTtl: '5m',
        targets: {
          openai: { host: 'api.openai.com', basePath: '/v1' },
          anthropic: { host: 'api.anthropic.com', basePath: '/v1' },
          copilot: { host: 'api.githubcopilot.com' },
          gemini: { host: 'generativelanguage.googleapis.com', basePath: '/v1beta' },
        },
        models: {
          'gpt-4o': ['gpt-4o-2024-11-20', 'gpt-4o-latest'],
        },
      },
      security: {
        sslBump: false,
        enableDlp: false,
        enableHostAccess: true,
        allowHostPorts: ['5432', '6379'],
        allowHostServicePorts: 'postgresql',
        difcProxy: { host: 'proxy.example.com', caCert: '/path/to/ca.crt' },
      },
      container: {
        memoryLimit: '4g',
        agentTimeout: 30,
        enableDind: false,
        workDir: '/tmp/awf-work',
        containerWorkDir: '/workspace',
        imageRegistry: 'ghcr.io/github/gh-aw-firewall',
        imageTag: 'latest',
        skipPull: false,
        buildLocal: false,
        agentImage: 'ghcr.io/actions/actions-runner:latest',
        tty: false,
        dockerHost: 'unix:///var/run/docker.sock',
      },
      environment: {
        envFile: '.env',
        envAll: false,
        excludeEnv: ['AWS_SECRET_ACCESS_KEY'],
      },
      logging: {
        logLevel: 'info',
        diagnosticLogs: true,
        auditDir: '/tmp/awf-audit',
        proxyLogsDir: '/tmp/awf-proxy-logs',
        sessionStateDir: '/tmp/gh-aw/sandbox/agent/session-state',
      },
      rateLimiting: {
        enabled: true,
        requestsPerMinute: 60,
        requestsPerHour: 1000,
        bytesPerMinute: 10485760,
      },
    };
    expect(validate(valid)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('rejects unknown top-level fields', () => {
    expect(validate({ unknown: true })).toBe(false);
    expect(validate.errors).not.toBeNull();
  });

  it('rejects unknown network fields', () => {
    expect(validate({ network: { unknownField: true } })).toBe(false);
  });

  it('rejects non-string $schema', () => {
    expect(validate({ $schema: 123 })).toBe(false);
  });

  it('rejects non-array network.allowDomains', () => {
    expect(validate({ network: { allowDomains: 'github.com' } })).toBe(false);
  });

  it('rejects invalid anthropicCacheTailTtl values', () => {
    expect(validate({ apiProxy: { anthropicCacheTailTtl: '10m' } })).toBe(false);
    expect(validate({ apiProxy: { anthropicCacheTailTtl: '5m' } })).toBe(true);
    expect(validate({ apiProxy: { anthropicCacheTailTtl: '1h' } })).toBe(true);
  });

  it('rejects invalid logging.logLevel values', () => {
    expect(validate({ logging: { logLevel: 'verbose' } })).toBe(false);
    expect(validate({ logging: { logLevel: 'debug' } })).toBe(true);
    expect(validate({ logging: { logLevel: 'info' } })).toBe(true);
    expect(validate({ logging: { logLevel: 'warn' } })).toBe(true);
    expect(validate({ logging: { logLevel: 'error' } })).toBe(true);
  });

  it('rejects non-positive-integer agentTimeout', () => {
    expect(validate({ container: { agentTimeout: 0 } })).toBe(false);
    expect(validate({ container: { agentTimeout: -1 } })).toBe(false);
    expect(validate({ container: { agentTimeout: 1 } })).toBe(true);
  });

  it('rejects non-positive-integer rateLimiting values', () => {
    expect(validate({ rateLimiting: { requestsPerMinute: 0 } })).toBe(false);
    expect(validate({ rateLimiting: { requestsPerMinute: 1 } })).toBe(true);
    expect(validate({ rateLimiting: { bytesPerMinute: -5 } })).toBe(false);
  });

  it('rejects copilot basePath (not supported)', () => {
    expect(validate({ apiProxy: { targets: { copilot: { host: 'api.githubcopilot.com', basePath: '/v1' } } } })).toBe(false);
  });

  it('accepts allowHostPorts as string or array of strings', () => {
    expect(validate({ security: { allowHostPorts: '5432' } })).toBe(true);
    expect(validate({ security: { allowHostPorts: ['5432', '6379'] } })).toBe(true);
    expect(validate({ security: { allowHostPorts: 5432 } })).toBe(false);
  });

  it('accepts apiProxy.models as object with string array values', () => {
    expect(validate({ apiProxy: { models: { 'gpt-4o': ['gpt-4o-2024-11-20'] } } })).toBe(true);
    expect(validate({ apiProxy: { models: { 'gpt-4o': 'not-an-array' } } })).toBe(false);
  });

  it('src/awf-config-schema.json stays in sync with docs/awf-config.schema.json', () => {
    const srcSchemaPath = path.join(__dirname, 'awf-config-schema.json');
    const srcSchema = JSON.parse(fs.readFileSync(srcSchemaPath, 'utf8'));
    // Compare all fields except $id (which differs for versioned releases)
    const docsRest = { ...schema };
    delete docsRest.$id;
    const srcRest = { ...srcSchema };
    delete srcRest.$id;
    expect(srcRest).toEqual(docsRest);
  });
});
