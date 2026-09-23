import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAwfFileConfig } from './config-file';
import { mapAwfFileConfigToCliOptions } from './config-mapper';
import { normalizeClaudeHostedWebPolicy } from './claude-hosted-web-policy';
import { validateWithSchema } from './schema-validator';
import { testHelpers } from './services/api-proxy-env-config';
import { WrapperConfig } from './types';

/**
 * Coverage for the config-only `apiProxy.hostedWeb.claude` policy:
 * schema validation, file/stdin parity in JSON and YAML, config mapping,
 * normalization, and serialization into the api-proxy sidecar environment.
 */

const ALLOW_CONFIG = {
  apiProxy: {
    hostedWeb: { claude: { enabled: true, allowedDomains: ['docs.github.com', 'nodejs.org'], maxUses: 5 } },
  },
};

describe('apiProxy.hostedWeb.claude schema', () => {
  it('accepts an allowlist policy', () => {
    expect(validateWithSchema(ALLOW_CONFIG)).toEqual([]);
  });

  it('accepts a blocklist policy', () => {
    expect(validateWithSchema({
      apiProxy: { hostedWeb: { claude: { enabled: true, blockedDomains: ['untrusted.example'] } } },
    })).toEqual([]);
  });

  it('accepts a disabled policy', () => {
    expect(validateWithSchema({ apiProxy: { hostedWeb: { claude: { enabled: false } } } })).toEqual([]);
  });

  it.each([
    ['mutually exclusive lists', { enabled: true, allowedDomains: ['a.com'], blockedDomains: ['b.com'] }],
    ['enabled without a domain mode', { enabled: true }],
    ['domains combined with enabled: false', { enabled: false, allowedDomains: ['a.com'] }],
    ['empty allowedDomains', { enabled: true, allowedDomains: [] }],
    ['empty blockedDomains', { enabled: true, blockedDomains: [] }],
    ['duplicate domains', { enabled: true, allowedDomains: ['a.com', 'a.com'] }],
    ['missing enabled', { allowedDomains: ['a.com'] }],
    ['scheme in domain', { enabled: true, allowedDomains: ['https://a.com'] }],
    ['uppercase domain', { enabled: true, allowedDomains: ['A.com'] }],
    ['wildcard domain', { enabled: true, allowedDomains: ['*.a.com'] }],
    ['port in domain', { enabled: true, allowedDomains: ['a.com:443'] }],
    ['path in domain', { enabled: true, allowedDomains: ['a.com/docs'] }],
    ['single-label host', { enabled: true, allowedDomains: ['localhost'] }],
    ['docker service alias', { enabled: true, allowedDomains: ['awf-api-proxy'] }],
    ['zero maxUses', { enabled: true, allowedDomains: ['a.com'], maxUses: 0 }],
    ['unknown property', { enabled: true, allowedDomains: ['a.com'], allowDomains: ['b.com'] }],
  ])('rejects %s', (_label, claude) => {
    expect(validateWithSchema({ apiProxy: { hostedWeb: { claude } } }).length).toBeGreaterThan(0);
  });

  it('rejects unknown providers under hostedWeb (closed object)', () => {
    expect(validateWithSchema({ apiProxy: { hostedWeb: { codex: { enabled: true } } } }).length).toBeGreaterThan(0);
  });

  it('keeps the public and runtime schema copies identical', () => {
    const docsSchema = fs.readFileSync(path.join(__dirname, '..', 'docs', 'awf-config.schema.json'), 'utf8');
    const runtimeSchema = fs.readFileSync(path.join(__dirname, 'awf-config-schema.json'), 'utf8');
    expect(runtimeSchema).toBe(docsSchema);
  });
});

describe('apiProxy.hostedWeb.claude config loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-hosted-web-test-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const YAML_CONFIG = [
    'apiProxy:',
    '  hostedWeb:',
    '    claude:',
    '      enabled: true',
    '      allowedDomains:',
    '        - docs.github.com',
    '        - nodejs.org',
    '      maxUses: 5',
    '',
  ].join('\n');

  it('loads identically from a JSON file, a YAML file, JSON stdin, and YAML stdin', () => {
    const jsonPath = path.join(testDir, 'awf.json');
    fs.writeFileSync(jsonPath, JSON.stringify(ALLOW_CONFIG));
    const yamlPath = path.join(testDir, 'awf.yaml');
    fs.writeFileSync(yamlPath, YAML_CONFIG);

    const loaded = [
      loadAwfFileConfig(jsonPath),
      loadAwfFileConfig(yamlPath),
      loadAwfFileConfig('-', () => JSON.stringify(ALLOW_CONFIG)),
      loadAwfFileConfig('-', () => YAML_CONFIG),
    ];

    for (const config of loaded) {
      expect(config.apiProxy?.hostedWeb?.claude).toEqual(ALLOW_CONFIG.apiProxy.hostedWeb.claude);
      expect(mapAwfFileConfigToCliOptions(config).claudeHostedWeb)
        .toEqual(ALLOW_CONFIG.apiProxy.hostedWeb.claude);
    }
  });

  it('rejects an invalid policy from stdin and names stdin as the source', () => {
    expect(() => loadAwfFileConfig(
      '-',
      () => JSON.stringify({ apiProxy: { hostedWeb: { claude: { enabled: true } } } }),
    )).toThrow('Invalid AWF config at stdin');
  });

  it('maps an absent policy to undefined (pass-through compatibility)', () => {
    expect(mapAwfFileConfigToCliOptions({}).claudeHostedWeb).toBeUndefined();
  });
});

describe('normalizeClaudeHostedWebPolicy', () => {
  it('returns undefined when no policy is configured', () => {
    expect(normalizeClaudeHostedWebPolicy(undefined)).toBeUndefined();
  });

  it('normalizes an allowlist policy', () => {
    expect(normalizeClaudeHostedWebPolicy({ enabled: true, allowedDomains: ['Docs.GitHub.com', 'docs.github.com'], maxUses: 3 }))
      .toEqual({ enabled: true, mode: 'allow', domains: ['docs.github.com'], maxUses: 3 });
  });

  it('normalizes a blocklist policy', () => {
    expect(normalizeClaudeHostedWebPolicy({ enabled: true, blockedDomains: ['ads.example'] }))
      .toEqual({ enabled: true, mode: 'block', domains: ['ads.example'] });
  });

  it('normalizes a disabled policy', () => {
    expect(normalizeClaudeHostedWebPolicy({ enabled: false }))
      .toEqual({ enabled: false, mode: null, domains: [] });
  });

  it.each([
    ['missing enabled', {}],
    ['both lists', { enabled: true, allowedDomains: ['a.com'], blockedDomains: ['b.com'] }],
    ['enabled without lists', { enabled: true }],
    ['lists with enabled false', { enabled: false, blockedDomains: ['b.com'] }],
    ['empty list', { enabled: true, allowedDomains: [] }],
    ['invalid domain', { enabled: true, allowedDomains: ['https://a.com'] }],
    ['ip address', { enabled: true, allowedDomains: ['10.0.0.1'] }],
    ['non-string domain', { enabled: true, allowedDomains: [7] }],
    ['invalid maxUses', { enabled: true, allowedDomains: ['a.com'], maxUses: 1.5 }],
  ])('throws for %s', (_label, claude) => {
    expect(() => normalizeClaudeHostedWebPolicy(claude as never, 'stdin')).toThrow(/stdin: apiProxy\.hostedWeb\.claude/);
  });
});

describe('AWF_CLAUDE_HOSTED_WEB_POLICY sidecar environment', () => {
  function env(config: Partial<WrapperConfig>): Record<string, string> {
    return testHelpers.buildModelPolicyEnv(config as WrapperConfig);
  }

  it('is absent when no policy is configured', () => {
    expect(env({}).AWF_CLAUDE_HOSTED_WEB_POLICY).toBeUndefined();
  });

  it('serializes one normalized policy object', () => {
    const value = env({
      claudeHostedWeb: { enabled: true, allowedDomains: ['docs.github.com'], maxUses: 5 },
    }).AWF_CLAUDE_HOSTED_WEB_POLICY;

    expect(JSON.parse(value)).toEqual({
      enabled: true, mode: 'allow', domains: ['docs.github.com'], maxUses: 5,
    });
  });

  it('serializes a disabled policy', () => {
    expect(JSON.parse(env({ claudeHostedWeb: { enabled: false } }).AWF_CLAUDE_HOSTED_WEB_POLICY))
      .toEqual({ enabled: false, mode: null, domains: [] });
  });

  it('fails before container startup on an invalid policy', () => {
    expect(() => env({ claudeHostedWeb: { enabled: true } })).toThrow(/apiProxy\.hostedWeb\.claude/);
  });

  it('never discloses network or sensitive allowlist entries to the provider', () => {
    const value = env({
      claudeHostedWeb: { enabled: true, allowedDomains: ['docs.github.com'] },
      allowedDomains: ['api.github.com', 'registry.npmjs.org'],
      sensitiveAllowedDomains: ['secrets.internal.example'],
    }).AWF_CLAUDE_HOSTED_WEB_POLICY;

    expect(value).not.toContain('secrets.internal.example');
    expect(value).not.toContain('api.github.com');
    expect(JSON.parse(value).domains).toEqual(['docs.github.com']);
  });
});
