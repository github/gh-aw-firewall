import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAwfFileConfig } from './config-file';
import { mapAwfFileConfigToCliOptions } from './config-mapper';
import { normalizeCodexHostedWebPolicy } from './codex-hosted-web-policy';
import { validateWithSchema } from './schema-validator';
import { testHelpers } from './services/api-proxy-env-config';
import { WrapperConfig } from './types';

const POLICY = { enabled: true, allowedDomains: ['docs.github.com', 'nodejs.org'], maxUses: 5 };
const CONFIG = { apiProxy: { hostedWeb: { codex: POLICY } } };

describe('apiProxy.hostedWeb.codex schema', () => {
  it.each([
    ['allowlist', POLICY],
    ['blocklist', { enabled: true, blockedDomains: ['untrusted.example'] }],
    ['disabled', { enabled: false }],
  ])('accepts %s mode', (_name, codex) => {
    expect(validateWithSchema({ apiProxy: { hostedWeb: { codex } } })).toEqual([]);
  });

  it.each([
    ['both lists', { enabled: true, allowedDomains: ['a.com'], blockedDomains: ['b.com'] }],
    ['missing mode', { enabled: true }],
    ['disabled with domains', { enabled: false, allowedDomains: ['a.com'] }],
    ['empty list', { enabled: true, allowedDomains: [] }],
    ['invalid domain', { enabled: true, allowedDomains: ['https://a.com'] }],
    ['raw IPv4 blocked domain', { enabled: true, blockedDomains: ['192.0.2.1'] }],
    ['overlong-label blocked domain', { enabled: true, blockedDomains: [`${'a'.repeat(64)}.example`] }],
    ['invalid maxUses', { enabled: true, allowedDomains: ['a.com'], maxUses: 0 }],
    ['unknown property', { enabled: true, allowedDomains: ['a.com'], extra: true }],
  ])('rejects %s', (_name, codex) => {
    expect(validateWithSchema({ apiProxy: { hostedWeb: { codex } } }).length).toBeGreaterThan(0);
  });

  it('allows Claude and Codex policies together', () => {
    expect(validateWithSchema({
      apiProxy: {
        hostedWeb: {
          claude: { enabled: true, blockedDomains: ['ads.example'] },
          codex: POLICY,
        },
      },
    })).toEqual([]);
  });
});

describe('apiProxy.hostedWeb.codex config loading', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-codex-hosted-web-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads and maps identically from JSON/YAML files and stdin', () => {
    const yaml = [
      'apiProxy:', '  hostedWeb:', '    codex:', '      enabled: true',
      '      allowedDomains:', '        - docs.github.com', '        - nodejs.org',
      '      maxUses: 5', '',
    ].join('\n');
    const jsonPath = path.join(dir, 'awf.json');
    const yamlPath = path.join(dir, 'awf.yaml');
    fs.writeFileSync(jsonPath, JSON.stringify(CONFIG));
    fs.writeFileSync(yamlPath, yaml);

    for (const loaded of [
      loadAwfFileConfig(jsonPath),
      loadAwfFileConfig(yamlPath),
      loadAwfFileConfig('-', () => JSON.stringify(CONFIG)),
      loadAwfFileConfig('-', () => yaml),
    ]) {
      expect(loaded.apiProxy?.hostedWeb?.codex).toEqual(POLICY);
      expect(mapAwfFileConfigToCliOptions(loaded).codexHostedWeb).toEqual(POLICY);
    }
  });

  it('identifies stdin validation failures', () => {
    expect(() => loadAwfFileConfig(
      '-',
      () => JSON.stringify({ apiProxy: { hostedWeb: { codex: { enabled: true } } } }),
    )).toThrow('Invalid AWF config at stdin');
  });
});

describe('Codex hosted-web normalization and sidecar environment', () => {
  const env = (config: Partial<WrapperConfig>) =>
    testHelpers.buildModelPolicyEnv(config as WrapperConfig);

  it('uses shared normalization and serializes only the explicit policy', () => {
    const normalized = normalizeCodexHostedWebPolicy({
      enabled: true,
      allowedDomains: ['Docs.GitHub.com', 'docs.github.com'],
      maxUses: 3,
    });
    expect(normalized).toEqual({
      enabled: true, mode: 'allow', domains: ['docs.github.com'], maxUses: 3,
    });

    const value = env({
      codexHostedWeb: POLICY,
      allowedDomains: ['api.github.com'],
      sensitiveAllowedDomains: ['secret.internal.example'],
    }).AWF_CODEX_HOSTED_WEB_POLICY;
    expect(JSON.parse(value)).toEqual({
      enabled: true, mode: 'allow', domains: ['docs.github.com', 'nodejs.org'], maxUses: 5,
    });
    expect(value).not.toContain('api.github.com');
    expect(value).not.toContain('secret.internal.example');
  });

  it('keeps omission as pass-through compatibility', () => {
    expect(env({}).AWF_CODEX_HOSTED_WEB_POLICY).toBeUndefined();
  });
});
