import type { WrapperConfig } from './types';
import { COPILOT_PLACEHOLDER_TOKEN } from './constants/placeholders';
import {
  COPILOT_BROKER_PRIVATE_ENV, COPILOT_BROKER_CONTEXT_ENV, copilotBrokerSensitiveValues,
  resolveCopilotBrokerRuntime, resolveCopilotBrokerUpstreams,
} from './copilot-token-broker';
import { OIDC_AUTH_ENV_VARS } from './api-proxy-env-constants';
import { buildApiProxyBaseEnv } from './services/api-proxy-env-config';
import { buildAgentEnvironment } from './services/agent-environment/environment-builder';
import { buildCopilotCredentialEnv } from './services/credentials/copilot-credential-env';
import { generateSquidConfig, generatePolicyManifest } from './squid-config';
import { mapAwfFileConfigToCliOptions } from './config-mapper';
import { validateWithSchema } from './schema-validator';
import { redactDockerComposeSecrets } from './compose-generator';
import { program } from './cli-options';
import { buildConfig } from './commands/build-config';
import { normalizeEnclavesConfig } from './parsers/enclave-parser';
import { buildMinimalBuildConfigInput } from './test-helpers/build-config.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configWriterTestHelpers } from './config-writer';

jest.mock('./logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const root = path.resolve(__dirname, '..');
const runtime = {
  GH_AW_TOKEN_BROKER_URL: 'https://broker.example.com:8443/mint?audience=a%2Fb&x=1',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/run/idtoken?api-version=2',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bootstrap-credential-only-for-sidecar',
  GITHUB_REPOSITORY_ID: '1234', GITHUB_REPOSITORY_OWNER_ID: '4567',
  GITHUB_RUN_ID: '8901', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'agent',
};
const network = {
  subnet: '172.28.0.0/24', squidIp: '172.28.0.10',
  agentIp: '172.28.0.20', proxyIp: '172.28.0.30',
};
const makeConfig = (extra: Partial<WrapperConfig> = {}): WrapperConfig => ({
  allowedDomains: [], agentCommand: 'true', workDir: root, logLevel: 'error', keepContainers: false,
  enableApiProxy: true, copilotTokenBroker: true, ...extra,
});
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const name of [
    ...OIDC_AUTH_ENV_VARS, 'COPILOT_GITHUB_TOKEN', 'COPILOT_TOKEN',
    'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_API_TARGET', 'COPILOT_API_BASE_PATH', 'AWF_AUTH_ANTHROPIC_TOKEN_URL',
    'AWF_AGENT_API_KEY', 'AWF_API_PROXY_PROVIDERS', 'AWF_FALLBACK_MODELS',
    'AWF_MODEL_FALLBACK', 'AWF_ROUTING_CONFIG', 'AWF_MODEL_ALIASES', 'AWF_BYOK_EXTRA_HEADERS',
    'AWF_BYOK_EXTRA_BODY_FIELDS', 'AWF_AUTH_HEADER',
  ]) delete process.env[name];
  Object.assign(process.env, runtime);
});
afterEach(() => { process.env = saved; });

it('maps only an explicit boolean opt-in, with no URL config surface', () => {
  expect(program.options.some(option => option.long === '--copilot-token-broker')).toBe(true);
  expect(mapAwfFileConfigToCliOptions({ apiProxy: { copilotTokenBroker: true } }).copilotTokenBroker).toBe(true);
  expect(validateWithSchema({ apiProxy: { copilotTokenBroker: true } })).toEqual([]);
  expect(validateWithSchema({ apiProxy: { copilotTokenBroker: 'true' } })).not.toEqual([]);
  expect(validateWithSchema({ apiProxy: { copilotTokenBroker: true, tokenBrokerUrl: runtime.GH_AW_TOKEN_BROKER_URL } })).not.toEqual([]);
  const config = makeConfig({ copilotTokenBroker: undefined });
  expect(resolveCopilotBrokerRuntime(config)).toBeUndefined();
  expect(buildApiProxyBaseEnv(config, network).AWF_COPILOT_TOKEN_BROKER).toBeUndefined();
});

it('builds actual CLI broker configuration without implicit fallback or routing defaults', () => {
  program.parse(['node', 'awf', '--copilot-token-broker', '--', 'true']);
  const config = buildConfig(buildMinimalBuildConfigInput({
    options: { ...program.opts(), enableApiProxy: true, workDir: root },
  }));
  expect(config.copilotTokenBroker).toBe(true);
  expect(config.modelFallback).toBeUndefined();
  expect(config.fallbackModels).toBeUndefined();
  expect(config.modelRouting).toBeUndefined();
  expect(config.apiProxyProviders).toBeUndefined();
  expect(buildApiProxyBaseEnv(config, network).AWF_COPILOT_TOKEN_BROKER).toBe('true');
});

it('preserves exact runtime URL and immutable host bootstrap/context', () => {
  const config = makeConfig({ additionalEnv: { GH_AW_TOKEN_BROKER_URL: 'https://attacker.example.com' } });
  const first = buildApiProxyBaseEnv(config, network);
  expect(first).toEqual(expect.objectContaining({ ...runtime, AWF_COPILOT_TOKEN_BROKER: 'true' }));
  process.env.GITHUB_RUN_ID = '9999';
  process.env.GH_AW_TOKEN_BROKER_URL = 'https://changed.example.com';
  expect(buildApiProxyBaseEnv(config, network)).toEqual(first);
  expect(Object.isFrozen(resolveCopilotBrokerRuntime(config)?.environment)).toBe(true);
});

it.each(Object.keys(runtime))('requires host runtime %s even with explicit sandbox env', name => {
  delete process.env[name];
  expect(() => resolveCopilotBrokerRuntime(makeConfig({ additionalEnv: runtime }))).toThrow(/requires host runtime/);
});

it.each([
  'http://broker.example.com', '******broker.example.com',
  'https://broker.example.com/#fragment', 'https://broker.example.com:22',
  'https://broker.example.com/#', 'https://@broker.example.com/mint',
  'https:broker.example.com', 'https:/broker.example.com',
  ' https://broker.example.com', 'https://broker.example.com\\evil',
])('rejects unsafe broker URL %s', url => {
  process.env.GH_AW_TOKEN_BROKER_URL = url;
  expect(() => resolveCopilotBrokerRuntime(makeConfig())).toThrow();
});

it.each([
  'https://broker.internal/mint',
  'https://broker.test/mint',
  'https://broker.invalid/mint',
  'https://broker/mint',
])('accepts deployment-owned exact DNS broker hostname %s', url => {
  process.env.GH_AW_TOKEN_BROKER_URL = url;
  const config = makeConfig();
  expect(buildApiProxyBaseEnv(config, network).GH_AW_TOKEN_BROKER_URL).toBe(url);
  expect(generateSquidConfig({
    domains: [], port: 3128, apiProxyIp: network.proxyIp,
    apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
  })).toContain('http_access allow api_upstream_source api_broker_connect');
});

it.each([
  ['https://192.0.2.77:8443/mint', '192.0.2.77/32'],
  ['https://[2001:db8::77]:8443/mint', '2001:db8::77/128'],
  ['https://127.0.0.1:8443/mint', '127.0.0.1/32'],
  ['https://[::1]:8443/mint', '::1/128'],
])('supports exact IP broker URL %s without generic or agent IP exceptions', (url, cidr) => {
  process.env.GH_AW_TOKEN_BROKER_URL = url;
  const config = makeConfig();
  const hostname = new URL(url).hostname;
  const squidConfig = {
    domains: [], port: 3128, sslBump: true,
    caFiles: { certPath: `${root}/ca.crt`, keyPath: `${root}/ca.key` },
    sslDbPath: `${root}/ssl-db`,
    sensitiveDomains: [hostname],
    blockedDomains: ['blocked.example.com'],
    enableDlp: true, apiProxyIp: network.proxyIp,
    apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
  };
  const squid = generateSquidConfig(squidConfig);
  expect(buildApiProxyBaseEnv(config, network).GH_AW_TOKEN_BROKER_URL).toBe(url);
  expect(squid).toContain(`acl api_upstream_0_host dst ${cidr}`);
  expect(squid).toContain(`acl api_broker_tls_0_host dst ${cidr}`);
  expect(squid).toContain(`acl api_broker_log_0_destination dst ${cidr}`);
  expect(squid).toContain(`acl api_broker_log_0_source src ${network.proxyIp}/32`);
  expect(squid).toContain('acl api_broker_log_0_private all-of api_broker_log_0_source api_broker_log_0_destination api_broker_log_0_port');
  for (const line of squid.split('\n').filter(value => value.startsWith('access_log '))) {
    expect(line).toContain('!api_broker_log_0_private');
  }
  const allow = 'http_access allow api_upstream_source api_broker_connect api_upstream_0_host api_upstream_0_port !blocked_domains !dlp_blocked';
  expect(squid).toContain(allow);
  expect(squid.indexOf(allow)).toBeLessThan(squid.indexOf('http_access deny dst_ipv4'));
  expect(squid).toContain('http_access deny dst_ipv4');
  expect(squid).toContain('http_access deny dst_ipv6');
  expect(squid).toContain('ssl_bump splice api_broker_tls_source api_broker_tls_0_host api_broker_tls_0_port');
  expect(squid).not.toContain('acl allowed_ips');
  expect(() => generateSquidConfig({
    ...squidConfig, apiProxyUpstreams: [{ hostname, port: 8443 }],
  })).toThrow(/SECURITY/);
});

it.each([
  'http://pipelines.actions.githubusercontent.com/idtoken',
  'https://untrusted.example.com/idtoken',
  'https://pipelines.actions.githubusercontent.com.evil.example/idtoken',
  'https://pipelines.actions.githubusercontent.com:8443/idtoken',
  'https://pipelines.actions.githubusercontent.com/idtoken#',
  'https://@pipelines.actions.githubusercontent.com/idtoken',
  'https:pipelines.actions.githubusercontent.com/idtoken',
])('rejects unsafe OIDC URL %s', url => {
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = url;
  expect(() => resolveCopilotBrokerRuntime(makeConfig())).toThrow(/Unsafe/);
});

it.each([
  { copilotGithubToken: 'real-token' }, { copilotProviderApiKey: 'byok' },
  { copilotProviderBaseUrl: 'https://other.example.com' },
  { copilotProviderType: 'azure' }, { authType: 'github-oidc' },
  { apiProxyProviders: {} }, { fallbackModels: [] }, { modelFallback: { enabled: true } },
  { experimentalModelRouting: true }, { copilotByokExtraHeaders: { Authorization: 'real' } },
  { modelAliases: { alias: ['openai/gpt-4.1'] } },
  { copilotApiTarget: 'http://api.githubcopilot.com' },
  { copilotApiTarget: 'https://api.githubcopilot.com/v1' },
  { copilotApiTarget: 'api.githubcopilot.com:8443' },
  { copilotApiTarget: 'api.githubcopilot.com.evil.example' },
  { copilotApiTarget: 'https://api.githubcopilot.com?' },
  { copilotApiBasePath: '/' },
  { copilotApiBasePath: '/custom' }, { enableApiProxy: false },
])('rejects conflicting configuration %j', extra => {
  expect(() => buildApiProxyBaseEnv(makeConfig(extra), network)).toThrow();
});

it.each(['COPILOT_GITHUB_TOKEN', 'COPILOT_TOKEN', 'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BASE_URL', 'AWF_AUTH_TYPE', 'AWF_FALLBACK_MODELS',
  'AWF_AUTH_HEADER',
])('rejects conflicting explicit or host env %s', name => {
  expect(() => resolveCopilotBrokerRuntime(makeConfig({ additionalEnv: { [name]: 'real' } }))).toThrow();
  process.env[name] = 'real';
  expect(() => resolveCopilotBrokerRuntime(makeConfig())).toThrow();
});

it('preserves unrelated GitHub credentials and accepts only approved Copilot targets', () => {
  process.env.GITHUB_TOKEN = 'unrelated-github-token';
  const config = makeConfig({ githubToken: 'unrelated-github-token', copilotApiTarget: 'https://api.enterprise.githubcopilot.com' });
  expect(buildApiProxyBaseEnv(config, network).COPILOT_API_TARGET).toBe('api.enterprise.githubcopilot.com');
  expect(config.githubToken).toBe('unrelated-github-token');
});

it.each(['', '   ', ' api.enterprise.githubcopilot.com '])('normalizes host Copilot target %j consistently', target => {
  process.env.COPILOT_API_TARGET = target;
  const config = makeConfig();
  const hostname = target.trim() || 'api.githubcopilot.com';
  expect(buildApiProxyBaseEnv(config, network).COPILOT_API_TARGET).toBe(hostname);
  expect(resolveCopilotBrokerUpstreams(config).slice(-1)[0]).toEqual({ hostname, port: 443 });
});

it('rejects broker authentication with agent enclaves before proxy construction', () => {
  const enclaves = normalizeEnclavesConfig([
    { agent: { model: 'gpt-5' }, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
  ]);
  expect(() => resolveCopilotBrokerRuntime(makeConfig({ enclaves }))).toThrow(/does not support agent enclaves/);
});

it('allows broker authentication with script-only enclaves', () => {
  const enclaves = normalizeEnclavesConfig([
    { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
  ]);
  expect(resolveCopilotBrokerRuntime(makeConfig({ enclaves }))).toBeDefined();
});

it.each([true, false])('isolates runtime env even with envAll=%s and explicit --env', envAll => {
  const config = makeConfig({
    envAll, additionalEnv: { ...runtime, AWF_COPILOT_TOKEN_BROKER: 'true' },
  });
  const agent = buildAgentEnvironment({ config, networkConfig: network, dnsServers: ['8.8.8.8'] });
  for (const name of COPILOT_BROKER_PRIVATE_ENV) expect(agent[name]).toBeUndefined();
  for (const name of COPILOT_BROKER_CONTEXT_ENV) expect(agent[name]).toBeUndefined();
  const routed = buildCopilotCredentialEnv({ config, proxyIp: network.proxyIp });
  expect(routed.COPILOT_PROVIDER_BASE_URL).toBe(`http://${network.proxyIp}:10002`);
  expect(routed.COPILOT_PROVIDER_API_KEY).toBe(COPILOT_PLACEHOLDER_TOKEN);
  expect(routed.COPILOT_TOKEN).toBe(COPILOT_PLACEHOLDER_TOKEN);
});

it('adds only exact source-scoped CONNECT egress with blocklist/DLP before safety rules', () => {
  const config = makeConfig();
  const squidConfig = {
    domains: ['explicit.example.com'], blockedDomains: ['blocked.example.com'],
    enableDlp: true, port: 3128, apiProxyIp: network.proxyIp,
    apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
  };
  const squid = generateSquidConfig(squidConfig);
  expect(squid).toContain(`acl api_upstream_source src ${network.proxyIp}/32`);
  expect(squid).toContain('acl api_upstream_0_host dstdom_regex -i -n ^broker\\.example\\.com$');
  expect(squid).toContain('acl api_upstream_0_port port 8443');
  expect(squid).toContain('acl api_upstream_1_port port 443');
  expect(squid).toContain('acl api_upstream_2_host dstdom_regex -i -n ^api\\.githubcopilot\\.com$');
  for (const [index, hostname] of [
    'broker\\.example\\.com', 'pipelines\\.actions\\.githubusercontent\\.com', 'api\\.githubcopilot\\.com',
  ].entries()) {
    expect(squid).toContain(`acl api_broker_log_${index}_destination dstdom_regex -i -n ^${hostname}$`);
    for (const line of squid.split('\n').filter(value => value.startsWith('access_log '))) {
      expect(line).toContain(`!api_broker_log_${index}_private`);
    }
  }
  for (const index of [0, 1]) {
    const allow = `http_access allow api_upstream_source api_broker_connect api_upstream_${index}_host api_upstream_${index}_port !blocked_domains !dlp_blocked`;
    expect(squid).toContain(allow);
    expect(squid.indexOf(allow)).toBeLessThan(squid.indexOf('http_access deny !Safe_ports'));
  }
  expect(squid).not.toMatch(/acl allowed_domains[^\n]*(broker\.example|actions\.githubusercontent)/);
  expect(squid).toContain('acl allowed_domains dstdomain .explicit.example.com');
  expect(generateSquidConfig({ ...squidConfig, apiProxyIp: undefined })).not.toContain('api_upstream_');
  const manifest = generatePolicyManifest(squidConfig);
  const rule = manifest.rules.find(entry => entry.id === 'allow-api-proxy-upstream-0')!;
  expect(rule.protocol).toBe('https');
  expect(rule.domains).toEqual([]);
  expect(rule.aclName).toContain('api_upstream_source api_broker_connect');
});

it('redacts broker/bootstrap endpoints from audit compose values', () => {
  const config = makeConfig();
  const compose = { services: { 'api-proxy': {
    environment: buildApiProxyBaseEnv(config, network),
  } } };
  const serialized = JSON.stringify(redactDockerComposeSecrets(compose as never, copilotBrokerSensitiveValues(config)));
  expect(serialized).not.toContain(runtime.GH_AW_TOKEN_BROKER_URL);
  expect(serialized).not.toContain(runtime.ACTIONS_ID_TOKEN_REQUEST_URL);
  expect(serialized).not.toContain(runtime.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
});

it('splices only trusted source/host/port broker TLS before any peek, stare, or bump', () => {
  const config = makeConfig();
  const squid = generateSquidConfig({
    domains: ['broker.example.com'], port: 3128, sslBump: true,
    caFiles: { certPath: `${root}/ca.crt`, keyPath: `${root}/ca.key` },
    sslDbPath: `${root}/ssl-db`, apiProxyIp: network.proxyIp,
    apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
  });
  expect(squid).toContain(`acl api_broker_tls_source src ${network.proxyIp}/32`);
  expect(squid).toContain('acl api_broker_tls_0_host dstdom_regex -i -n ^broker\\.example\\.com$');
  expect(squid).toContain('acl api_broker_tls_0_port port 8443');
  for (const index of [0, 1, 2]) {
    const splice = `ssl_bump splice api_broker_tls_source api_broker_tls_${index}_host api_broker_tls_${index}_port`;
    expect(squid).toContain(splice);
    expect(squid.indexOf(splice)).toBeLessThan(squid.indexOf('ssl_bump peek step1'));
    expect(squid.indexOf(splice)).toBeLessThan(squid.indexOf('ssl_bump stare step2'));
  }
  expect(squid).not.toContain('ssl_bump splice api_broker_tls_0_host');
  expect(squid).toContain('ssl_bump bump allowed_domains');
});

it.each([
  runtime.GH_AW_TOKEN_BROKER_URL,
  'https://192.0.2.77:8443/mint',
  'https://[2001:db8::77]:8443/mint',
])('writes audit artifacts without raw/escaped/encoded broker endpoint %s', url => {
  process.env.GH_AW_TOKEN_BROKER_URL = url;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-audit-'));
  try {
    const config = makeConfig({ auditDir: directory });
    const squid = generateSquidConfig({
      domains: [], port: 3128, apiProxyIp: network.proxyIp,
      apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
    });
    const compose = { services: {
      'api-proxy': { environment: buildApiProxyBaseEnv(config, network) },
      'squid-proxy': { environment: { AWF_SQUID_CONFIG_B64: Buffer.from(squid).toString('base64') } },
    } };
    configWriterTestHelpers.writeAuditArtifacts(config, network, compose as never, squid);
    const forms = copilotBrokerSensitiveValues(config);
    if (url === runtime.GH_AW_TOKEN_BROKER_URL) {
      expect(forms).toContain('broker\\.example\\.com');
      expect(forms).toContain('broker\\\\.example\\\\.com');
    }
    for (const filename of ['squid.conf', 'policy-manifest.json', 'docker-compose.redacted.yml']) {
      const contents = fs.readFileSync(path.join(directory, filename), 'utf8');
      for (const form of forms) expect(contents).not.toContain(form);
      expect(contents).not.toContain(Buffer.from(squid).toString('base64'));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
