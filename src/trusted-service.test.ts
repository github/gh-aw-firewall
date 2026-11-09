import fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { DockerComposeConfig, WrapperConfig } from './types';
import {
  validateTrustedService, trustedServiceTargets, isolateTrustedServiceEnvironment,
} from './trusted-service';
import { validateAwfFileConfig } from './config-file';
import { mapAwfFileConfigToCliOptions } from './config-mapper';
import { resolveApiCredentials } from './commands/resolve-credentials';
import { buildProviderTargetEnv, resolveApiProxyUpstreams } from './services/api-proxy-env-config';
import { buildApiProxyServiceConfig } from './services/api-proxy-service-config';
import { buildAgentEnvironment } from './services/agent-environment/environment-builder';
import { buildExclusionSet } from './services/agent-environment/excluded-vars';
import { resolveAllowedDomains } from './commands/preflight';
import { renderDockerCompose } from './compose-renderer';
import { logger } from './logger';
import { generateSquidConfig, generatePolicyManifest } from './squid-config';

jest.mock('./logger', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const service = { endpoint: 'https://service.example.com/corporate', secretHeaders: { 'X-Corporate-Secret': 'CORPORATE_SECRET' } };
const baseConfig = { workDir: process.cwd(), allowedDomains: [], agentCommand: 'true', enableApiProxy: true } as unknown as WrapperConfig;
const networkConfig = { subnet: '172.30.0.0/24', squidIp: '172.30.0.10', agentIp: '172.30.0.20', proxyIp: '172.30.0.30' };

describe('trusted service configuration and credential isolation', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...savedEnv, CORPORATE_SECRET: 'supplemental-sensitive-value' };
    for (const name of ['OPENAI_API_TARGET', 'OPENAI_API_BASE_PATH', 'OPENAI_ENDPOINT_OVERRIDE',
      'OPENAI_BASE_URL_ENV', 'COPILOT_PROVIDER_BASE_URL', 'ANTHROPIC_API_TARGET', 'ANTHROPIC_API_BASE_PATH']) delete process.env[name];
  });
  afterAll(() => { process.env = savedEnv; });

  it('maps the opt-in config through credential resolution and existing target admission', () => {
    const options = mapAwfFileConfigToCliOptions({ apiProxy: { targets: { anthropic: { trustedService: service } } } });
    const config = { ...baseConfig, ...resolveApiCredentials(options) };
    expect(config.anthropicTrustedService).toEqual(service);
    expect(buildProviderTargetEnv(config)).toMatchObject({
      ANTHROPIC_API_TARGET: 'service.example.com', ANTHROPIC_API_BASE_PATH: '/corporate',
      AWF_ANTHROPIC_TRUSTED_SERVICE: JSON.stringify(service),
    });
    expect(resolveApiProxyUpstreams(config)).toContainEqual({ hostname: 'service.example.com', port: 443, proxyOnly: true });
  });

    it('admits only the proxy source to the exact HTTPS service, without broadening the agent allowlist', () => {
      const config = { ...baseConfig, anthropicTrustedService: service };
      const domains = resolveAllowedDomains({ allowDomains: 'allowed.example.net', anthropicTrustedService: service });
      expect(domains.allowedDomains.join(',')).not.toContain('service.example.com');
      expect(domains.sensitiveAllowedDomains.join(',')).not.toContain('service.example.com');
      const squid = {
        domains: domains.allowedDomains, port: 3128, apiProxyIp: networkConfig.proxyIp,
        apiProxyUpstreams: resolveApiProxyUpstreams(config), blockedDomains: ['service.example.com'], enableDlp: true,
      };
      const generated = generateSquidConfig(squid);
      expect(generated).toContain('acl api_upstream_source src 172.30.0.30/32');
      expect(generated).toContain('acl api_upstream_0_host dstdom_regex -i -n ^service\\.example\\.com$');
      expect(generated).toContain('acl api_upstream_0_port port 443');
      expect(generated).toContain('http_access allow api_upstream_source api_upstream_connect api_upstream_0_host api_upstream_0_port !blocked_domains !dlp_blocked');
      expect(generated).toContain('http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port blocked_domains');
      expect(generated).toContain('http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port dlp_blocked');
      expect(generated).toContain('ssl_bump splice tls_sni_guard_api_proxy');
      expect(generateSquidConfig({
        ...squid, sslBump: true, caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' }, sslDbPath: '/ssl-db',
      })).toContain('ssl_bump splice api_broker_tls_source api_broker_tls_0_host api_broker_tls_0_port');
      expect(generated).toContain('acl blocked_domains dstdomain .service.example.com');
      expect(generated).not.toContain('acl allowed_domains dstdomain .service.example.com');
      expect(generated.indexOf('http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port blocked_domains'))
        .toBeLessThan(generated.indexOf('http_access allow from_api_proxy'));
      expect(generated.indexOf('http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port dlp_blocked'))
        .toBeLessThan(generated.indexOf('http_access allow from_api_proxy'));
      const rule = generatePolicyManifest(squid).rules.find(rule => rule.id === 'allow-api-proxy-upstream-0');
      expect(rule?.aclName).toContain('api_upstream_connect');
      expect(rule?.protocol).toBe('https');
    });

  it.each(['openai', 'anthropic'] as const)('accepts schema only for supported target %s', provider => {
    expect(validateAwfFileConfig({ apiProxy: { targets: { [provider]: { trustedService: service } } } })).toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { targets: { [provider]: { host: 'other.example', trustedService: service } } } })).not.toEqual([]);
    expect(validateAwfFileConfig({ apiProxy: { targets: { gemini: { trustedService: service } } } })).not.toEqual([]);
  });

  it.each([
    'http://service.example', '******service.example', 'https://service.example:444',
    'https://service.example/path?q=secret', 'https://service.example/#fragment',
    'https://service.example/a/../b', 'https://service.example/%2e%2e',
    'https://service.example/a\\b', 'https://service.example//../b',
    'https://localhost', 'https://service.example.', 'https://service.example:22',
    'https://127.0.0.1', 'https://service..example', 'https://-service.example',
    'https://api.localhost', 'https://host.docker.internal', 'https://api.local', 'https://api.localdomain',
  ])('rejects unsafe endpoint %s', endpoint => {
    expect(() => validateTrustedService({ ...service, endpoint })).toThrow(/endpoint/);
  });

  it.each(['Authorization', 'X-Api-Key', 'api-key', 'Host', 'Connection', 'Proxy-Authorization',
    'X-Forwarded-Host', 'Content-Length', 'Transfer-Encoding', 'Content-Type',
    'Anthropic-Version', 'x-awf-caller', 'Forwarded', 'Cookie', 'x-request-id', 'Bad Header',
  ])('rejects reserved secret header %s', header => {
    expect(() => validateTrustedService({ ...service, secretHeaders: { [header]: 'CORPORATE_SECRET' } })).toThrow(/header/);
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '\t', ' ', '\0'])(
    'rejects leading/trailing whitespace and controls in all configuration names: %j', padding => {
      for (const prefix of [true, false]) {
        const pad = (value: string) => prefix ? padding + value : value + padding;
        const cases = [
          { ...service, endpoint: pad('https://service.example.com') },
          { ...service, secretHeaders: { [pad('authorization')]: 'CORPORATE_SECRET' } },
          { ...service, secretHeaders: { [pad('x-corp')]: 'CORPORATE_SECRET' } },
          { ...service, secretHeaders: { 'x-corp': pad('CORPORATE_SECRET') } },
        ];
        for (const candidate of cases) {
          expect(() => validateTrustedService(candidate)).toThrow(/trustedService/);
          expect(validateAwfFileConfig({ apiProxy: { targets: { anthropic: { trustedService: candidate } } } }))
            .not.toEqual([]);
        }
      }
    },
  );

  it('rejects custom auth collisions, case-insensitive duplicates and dangerous source env names', () => {
    expect(() => validateTrustedService(service, 'x-corporate-secret')).toThrow(/header/);
    expect(() => validateTrustedService(service, ' X-Corporate-Secret ')).toThrow(/header/);
    expect(() => validateTrustedService({ ...service, secretHeaders: { 'X-Corp': 'CORPORATE_SECRET', 'x-corp': 'CORPORATE_SECRET' } })).toThrow(/header/);
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'AWF_MAX_RUNS', 'PATH']) {
      expect(() => validateTrustedService({ ...service, secretHeaders: { 'x-corp': name } })).toThrow(/environment/);
    }
  });

  it('fails closed on missing, empty and invalid runner secrets without echoing values', () => {
    const config = { ...baseConfig, openaiTrustedService: service };
    for (const value of [undefined, '', 'secret\r\nmalicious: value']) {
      if (value === undefined) delete process.env.CORPORATE_SECRET;
      else process.env.CORPORATE_SECRET = value;
      expect(() => trustedServiceTargets(config)).toThrow(/secret/);
    }
  });

  it('rejects conflicting config and environment routing, including custom auth collisions', () => {
    const config = { ...baseConfig, openaiTrustedService: service };
    for (const overrides of [{ openaiApiTarget: 'other.example' }, { openaiApiBasePath: '/v2' },
      { openaiBaseUrlEnv: 'PRIVATE_URL' }, { copilotProviderBaseUrl: 'https://other.example' },
      { additionalEnv: { OPENAI_ENDPOINT_OVERRIDE: 'https://other.example' } }]) {
      expect(() => trustedServiceTargets({ ...config, ...overrides })).toThrow(/combined/);
    }
    expect(() => trustedServiceTargets({ ...config, openaiApiAuthHeader: 'X-Corporate-Secret' })).toThrow(/header/);
    process.env.OPENAI_API_TARGET = 'other.example';
    expect(() => trustedServiceTargets(config)).toThrow(/combined/);
  });

  it('fails unsupported proxy bypass, routing and signed-cloud configurations closed', () => {
    const config = { ...baseConfig, openaiTrustedService: service };
    expect(() => trustedServiceTargets({ ...config, enableApiProxy: false })).toThrow(/requires/);
    expect(() => trustedServiceTargets({ ...config, experimentalModelRouting: true })).toThrow(/routing/);
    for (const containerRuntime of ['gvisor', 'kata', 'sbx', 'cloud-hypervisor', 'nvx']) {
      expect(() => trustedServiceTargets({ ...config, containerRuntime })).toThrow(/Docker runtime/);
    }
    for (const authProvider of ['aws', 'gcp'] as const) {
      expect(() => trustedServiceTargets({ ...config, authType: 'github-oidc', authProvider })).toThrow(/signing/);
    }
    for (const [authType, authProvider] of [[' GitHub-OIDC ', ' AWS '], ['GITHUB-OIDC', 'GCP']] as const) {
      expect(() => trustedServiceTargets({
        ...config, authType, authProvider,
      } as unknown as WrapperConfig)).toThrow(/signing/);
    }
  });

  it('handles trusted-service validation errors through the preflight exit path', () => {
    const secret = process.env.CORPORATE_SECRET;
    delete process.env.CORPORATE_SECRET;
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    try {
      expect(() => resolveAllowedDomains({
        anthropicTrustedService: service,
      })).toThrow('process.exit called');
      expect(logger.error).toHaveBeenCalledWith('Missing trustedService secret in runner environment');
    } finally {
      exit.mockRestore();
      if (secret === undefined) delete process.env.CORPORATE_SECRET;
      else process.env.CORPORATE_SECRET = secret;
    }
  });

  it('rejects blocked destinations before startup using exact, parent and wildcard domain rules', () => {
    const config = { ...baseConfig, anthropicTrustedService: service };
    for (const blockedDomains of [['service.example.com'], ['example.com'], ['.example.com'],
      ['*.example.com'], ['https://service.example.com/'], ['http://service.example.com'], ['SERVICE.EXAMPLE.COM']]) {
      expect(() => trustedServiceTargets({ ...config, blockedDomains })).toThrow(/blockedDomains/);
    }
    expect(() => trustedServiceTargets({ ...config, blockedDomains: ['other.example.com'] })).not.toThrow();
  });

  it('serializes only env-name references and null Compose pass-through, without network changes', () => {
    const config = { ...baseConfig, anthropicTrustedService: service, openaiTrustedService: service };
    const result = buildApiProxyServiceConfig({
      config, networkConfig, apiProxyLogsPath: path.join(process.cwd(), 'proxy-logs'),
      imageConfig: { useGHCR: true, registry: 'example.com', parsedTag: { tag: 'latest', digests: {} }, projectRoot: process.cwd() } as any,
    });
    expect(result.environment.CORPORATE_SECRET).toBeNull();
    expect(result.environment.AWF_ANTHROPIC_TRUSTED_SERVICE).toBe(JSON.stringify(service));
    expect(JSON.stringify(result)).not.toContain(process.env.CORPORATE_SECRET);
    expect(Object.keys(result.networks)).toEqual(['awf-net']);

    const compose = { services: { 'api-proxy': result }, networks: {} } as DockerComposeConfig;
    const parsed = yaml.load(renderDockerCompose(compose)) as DockerComposeConfig;
    expect(parsed.services['api-proxy'].environment?.CORPORATE_SECRET).toBeNull();
  });

  it('removes secret names and aliased values after every environment merge', () => {
    const config = { ...baseConfig, anthropicTrustedService: service };
    expect(buildExclusionSet(config).has('CORPORATE_SECRET')).toBe(true);
    const env = { CORPORATE_SECRET: 'override', ALIAS: `prefix-${process.env.CORPORATE_SECRET}`, SAFE: 'visible' };
    isolateTrustedServiceEnvironment(config, env);
    expect(env).toEqual({ SAFE: 'visible' });
  });

  it('isolates envAll, env files, explicit overrides and their value aliases in the actual agent builder', () => {
    const file = path.join(process.cwd(), 'virtual-trusted-service.env');
    const originalRead = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((...args) => args[0] === file
      ? `CORPORATE_SECRET=override\nFILE_ALIAS=${process.env.CORPORATE_SECRET}\n`
      : originalRead(...args));
    try {
      const config = {
        ...baseConfig, anthropicTrustedService: service, envAll: true, envFile: file,
        additionalEnv: { CORPORATE_SECRET: 'override', EXPLICIT_ALIAS: `prefix-${process.env.CORPORATE_SECRET}` },
      };
      const env = buildAgentEnvironment({ config, networkConfig, dnsServers: ['8.8.8.8'] });
      expect(env.CORPORATE_SECRET).toBeUndefined();
      expect(env.FILE_ALIAS).toBeUndefined();
      expect(env.EXPLICIT_ALIAS).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(process.env.CORPORATE_SECRET);
    } finally { read.mockRestore(); }
  });
});
