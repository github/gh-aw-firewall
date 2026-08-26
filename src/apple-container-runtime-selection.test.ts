/**
 * Runtime selection surface for the Apple Container preview: the registry
 * entry, the backend resolver, option parsing, and the infrastructure-only
 * Compose output.
 *
 * These are the seams where a mistake is silent rather than loud — a runtime
 * that falls through to Compose, an opt-in that is not enforced, or a port
 * published on every interface — so each is asserted directly.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateDockerCompose } from './compose-generator';
import {
  runtimeNeedsStaticDns,
  runtimeUsesComposeAgent,
  runtimeUsesIptables,
  resolveDockerRuntime,
} from './container-runtime';
import { resolveExternalRuntimeBackend } from './external-runtime-backend-resolver';
import { APPLE_CONTAINER_RUNTIME } from './apple-container/runtime-validation';
import { apiProxyPorts, SQUID_PORT } from './config/network-policy';
import type { WrapperConfig } from './types';

const AGENT_IMAGE = 'ghcr.io/github/gh-aw-firewall/agent:1.0.0@sha256:' + 'a'.repeat(64);
const INIT_IMAGE = 'ghcr.io/github/gh-aw-firewall/apple-init:1.0.0@sha256:' + 'b'.repeat(64);

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-apple-selection-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'true',
    logLevel: 'info',
    workDir,
    containerRuntime: APPLE_CONTAINER_RUNTIME,
    networkIsolation: true,
    appleContainer: { previewEnabled: true, cpus: 4, memory: '8G' },
    ...overrides,
  } as unknown as WrapperConfig;
}

const networkConfig = {
  subnet: '172.30.0.0/24',
  squidIp: '172.30.0.10',
  agentIp: '172.30.0.20',
  proxyIp: '172.30.0.30',
};

describe('runtime registry', () => {
  it('treats apple-container as an external microVM, not a Compose agent', () => {
    expect(runtimeUsesComposeAgent(APPLE_CONTAINER_RUNTIME)).toBe(false);
  });

  it('declares no Docker OCI runtime for it', () => {
    expect(resolveDockerRuntime(APPLE_CONTAINER_RUNTIME)).toBeUndefined();
  });

  it('does not attempt static DNS or host-netns iptables for a NIC-less guest', () => {
    expect(runtimeNeedsStaticDns(APPLE_CONTAINER_RUNTIME)).toBe(false);
    expect(runtimeUsesIptables(APPLE_CONTAINER_RUNTIME)).toBe(false);
  });

  it('leaves the other runtimes unchanged', () => {
    expect(runtimeUsesComposeAgent('gvisor')).toBe(true);
    expect(runtimeUsesComposeAgent('sbx')).toBe(false);
    expect(runtimeUsesComposeAgent('cloud-hypervisor')).toBe(false);
    expect(resolveDockerRuntime('gvisor')).toBe('runsc');
    expect(runtimeUsesIptables('gvisor')).toBe(false);
    expect(runtimeUsesIptables(undefined)).toBe(true);
  });
});

describe('resolveExternalRuntimeBackend', () => {
  const startInfrastructure = jest.fn();

  it('resolves the Apple Container backend when the preview is enabled', () => {
    const backend = resolveExternalRuntimeBackend(config(), startInfrastructure);
    expect(backend?.runtime).toBe(APPLE_CONTAINER_RUNTIME);
  });

  it('refuses to resolve without the explicit preview opt-in', () => {
    expect(() => resolveExternalRuntimeBackend(
      config({ appleContainer: { previewEnabled: false, cpus: 4, memory: '8G' } }),
      startInfrastructure,
    )).toThrow('--apple-container-preview');
  });

  it('refuses to resolve with no Apple Container configuration at all', () => {
    expect(() => resolveExternalRuntimeBackend(
      config({ appleContainer: undefined }),
      startInfrastructure,
    )).toThrow('--apple-container-preview');
  });

  it('still returns undefined for Compose runtimes', () => {
    expect(resolveExternalRuntimeBackend(
      config({ containerRuntime: 'gvisor', appleContainer: undefined }),
      startInfrastructure,
    )).toBeUndefined();
  });
});

describe('infrastructure-only Compose generation', () => {
  it('omits the agent and the iptables-init container', () => {
    const compose = generateDockerCompose(config({ images: { agent: AGENT_IMAGE, appleInit: INIT_IMAGE, squid: AGENT_IMAGE } as WrapperConfig['images'] }), networkConfig);
    expect(compose.services.agent).toBeUndefined();
    expect(compose.services['iptables-init']).toBeUndefined();
    expect(compose.services['squid-proxy']).toBeDefined();
  });

  it('publishes Squid to loopback only, replacing the wildcard mapping', () => {
    const compose = generateDockerCompose(config(), networkConfig);
    expect((compose.services['squid-proxy'] as { ports: string[] }).ports)
      .toEqual([`127.0.0.1:${SQUID_PORT}:${SQUID_PORT}`]);
  });

  it('publishes the four allowlisted provider ports to loopback and never Vertex', () => {
    const compose = generateDockerCompose(config({ enableApiProxy: true }), networkConfig);
    const ports = (compose.services['api-proxy'] as { ports: string[] }).ports;
    const expected = apiProxyPorts();
    expect(ports).toEqual([
      `127.0.0.1:${expected.openai}:${expected.openai}`,
      `127.0.0.1:${expected.anthropic}:${expected.anthropic}`,
      `127.0.0.1:${expected.copilot}:${expected.copilot}`,
      `127.0.0.1:${expected.gemini}:${expected.gemini}`,
    ]);
    expect(ports.some((entry) => entry.includes(String(expected.vertex)))).toBe(false);
  });

  it('binds nothing to a wildcard address', () => {
    const compose = generateDockerCompose(config({ enableApiProxy: true }), networkConfig);
    for (const service of Object.values(compose.services)) {
      for (const port of (service as { ports?: string[] }).ports ?? []) {
        expect(port.startsWith('127.0.0.1:')).toBe(true);
      }
    }
  });

  it('attaches publishing services to the external bridge in isolation mode', () => {
    const compose = generateDockerCompose(config({ enableApiProxy: true }), networkConfig);
    const squid = compose.services['squid-proxy'] as { networks: Record<string, unknown> };
    const proxy = compose.services['api-proxy'] as { networks: Record<string, unknown> };
    expect(Object.keys(squid.networks)).toContain('awf-ext');
    expect(Object.keys(proxy.networks)).toContain('awf-ext');
  });

  it('leaves the sbx wildcard publication path untouched', () => {
    const compose = generateDockerCompose(
      config({
        containerRuntime: 'sbx',
        appleContainer: undefined,
        enableApiProxy: true,
      }),
      networkConfig,
    );
    const ports = (compose.services['api-proxy'] as { ports: string[] }).ports;
    const expected = apiProxyPorts();
    expect(ports).toContain(`${expected.openai}:${expected.openai}`);
  });
});
