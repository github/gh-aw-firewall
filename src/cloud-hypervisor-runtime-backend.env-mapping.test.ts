import type { WrapperConfig } from './types';
import { buildCloudHypervisorGuestEnvironment } from './cloud-hypervisor/guest-environment-builder';
import { assertCloudHypervisorPreSecurityCompatibility } from './cloud-hypervisor-runtime-backend';
import { assertCloudHypervisorSelection } from './cloud-hypervisor/runtime-validation';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'cloud-hypervisor',
    cloudHypervisor: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      artifactManifestPath: '/opt/manifest.json',
      artifactManifestBundlePath: '/opt/manifest.sigstore.jsonl',
      artifactReleaseTag: 'test',
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
    },
    agentCommand: 'printf hello',
    allowedDomains: ['github.com'],
    workDir: '/tmp/awf',
    keepContainers: false,
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    logLevel: 'info',
    buildLocal: false,
    skipPull: true,
    imageRegistry: 'registry',
    imageTag: 'tag',
    envAll: false,
    sslBump: false,
    enableDlp: false,
    ...overrides,
  } as WrapperConfig;
}

function infrastructure() {
  return {
    networkId: 'a'.repeat(64),
    bridgeName: 'br-aaaaaaaaaaaa',
    subnet: '172.30.0.0/24',
    gateway: '172.30.0.1',
    squidIp: '172.30.0.10',
    apiProxyIp: '172.30.0.30',
    topologyPeerIps: {},
    revalidate: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Cloud Hypervisor runtime backend environment and path mapping', () => {
  it('preserves sanitized env values without leaking real provider secrets', () => {
    const secret = 'sk-real-provider-' + 'secret';
    const environment = buildCloudHypervisorGuestEnvironment(
      config({
        openaiApiKey: secret,
        additionalEnv: {
          SAFE_SETTING: 'enabled',
          OPENAI_API_KEY: secret,
        },
      }),
      infrastructure(),
    );

    expect(environment.SAFE_SETTING).toBe('enabled');
    expect(environment.OPENAI_API_KEY).not.toBe(secret);
    expect(Object.values(environment)).not.toContain(secret);
    expect(environment.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(environment.HOME).toBe('/workspace/.awf-home');

    expect(() => buildCloudHypervisorGuestEnvironment(
      config({
        openaiApiKey: 'enabled',
        additionalEnv: { SAFE_SETTING: 'enabled' },
      }),
      infrastructure(),
    )).toThrow(/Refusing to pass a real provider credential/);
  });

  it('sets lowercase http_proxy so BusyBox wget honors the proxy for https:// too', () => {
    // Regression coverage: a live-KVM connectivity investigation found
    // BusyBox wget reads only the lowercase "http_proxy" env var for
    // every protocol it supports, including https -- there is no
    // https_proxy check anywhere in its proxy-detection logic. Without
    // this (the shared container-runtime environment intentionally
    // omits it, for curl/Ubuntu-specific reasons that don't apply to
    // this guest's BusyBox wget), wget silently falls back to a direct,
    // unproxied connection attempt, which fails outright since guest DNS
    // is unconditionally blocked by network policy.
    const environment = buildCloudHypervisorGuestEnvironment(config(), infrastructure());

    expect(environment.http_proxy).toBe('http://172.30.0.10:3128');
  });

  it('maps only exported runner paths and keeps the guest home in the writable workspace', () => {
    const previousToolCache = process.env.RUNNER_TOOL_CACHE;
    const previousRunnerTemp = process.env.RUNNER_TEMP;
    try {
      process.env.RUNNER_TOOL_CACHE = '/opt/hostedtoolcache';
      process.env.RUNNER_TEMP = '/home/runner/work/_temp';
      const environment = buildCloudHypervisorGuestEnvironment(
        config(),
        infrastructure(),
        '100.64.0.2',
        [
          { tag: 'workspace', source: '/host/workspace', target: '/workspace', mode: 'rw' },
          {
            tag: 'runner-tool-cache',
            source: '/opt/hostedtoolcache',
            target: '/opt/hostedtoolcache',
            mode: 'ro',
          },
          {
            tag: 'runner-temp-gh-aw',
            source: '/home/runner/work/_temp/gh-aw',
            target: '/home/runner/work/_temp/gh-aw',
            mode: 'ro',
          },
        ],
      );
      expect(environment).toMatchObject({
        HOME: '/workspace/.awf-home',
        GITHUB_WORKSPACE: '/workspace',
        RUNNER_TOOL_CACHE: '/opt/hostedtoolcache',
        RUNNER_TEMP: '/home/runner/work/_temp',
      });
    } finally {
      if (previousToolCache === undefined) delete process.env.RUNNER_TOOL_CACHE;
      else process.env.RUNNER_TOOL_CACHE = previousToolCache;
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
    }
  });

  it('does not forward runner path variables without matching exports', () => {
    const previousToolCache = process.env.RUNNER_TOOL_CACHE;
    const previousAgentTools = process.env.AGENT_TOOLSDIRECTORY;
    const previousRunnerTemp = process.env.RUNNER_TEMP;
    try {
      process.env.RUNNER_TOOL_CACHE = '/opt/hostedtoolcache';
      process.env.AGENT_TOOLSDIRECTORY = '/opt/agent-tools';
      process.env.RUNNER_TEMP = '/home/runner/work/_temp';
      const environment = buildCloudHypervisorGuestEnvironment(
        config(),
        infrastructure(),
        '100.64.0.2',
        [{ tag: 'workspace', source: '/host/workspace', target: '/workspace', mode: 'rw' }],
      );

      expect(environment.RUNNER_TOOL_CACHE).toBeUndefined();
      expect(environment.AGENT_TOOLSDIRECTORY).toBeUndefined();
      expect(environment.RUNNER_TEMP).toBeUndefined();
    } finally {
      if (previousToolCache === undefined) delete process.env.RUNNER_TOOL_CACHE;
      else process.env.RUNNER_TOOL_CACHE = previousToolCache;
      if (previousAgentTools === undefined) delete process.env.AGENT_TOOLSDIRECTORY;
      else process.env.AGENT_TOOLSDIRECTORY = previousAgentTools;
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
    }
  });

  it('rejects unsupported strict-security and topology combinations', () => {
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config({ enableDind: true }),
    )).toThrow(/Docker-in-Docker/);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config({ enableHostAccess: true }),
    )).toThrow(/host access/);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config({ enclaves: { enabled: true } } as Partial<WrapperConfig>),
    )).toThrow(/DIFC proxies or enclaves/);
    expect(() => assertCloudHypervisorSelection(
      config({ containerRuntime: 'gvisor' }),
    )).toThrow(/require --container-runtime cloud-hypervisor/);
  });
});
