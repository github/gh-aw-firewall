import {
  APPLE_CONTAINER_LOOPBACK_HOST,
  appleContainerLoopbackPortConflicts,
  appleContainerPortMapping,
  applyAppleContainerLoopbackPublishing,
  planAppleContainerInfrastructure,
} from './infrastructure-endpoints';
import { apiProxyPorts, CLI_PROXY_PORT, SQUID_PORT } from '../config/network-policy';
import { APPLE_CONTAINER_TRANSPORT_CAPABILITIES } from './transport-capabilities';
import type { WrapperConfig } from '../types';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'true',
    logLevel: 'info',
    workDir: '/tmp/awf-test',
    containerRuntime: 'apple-container',
    networkIsolation: true,
    ...overrides,
  } as unknown as WrapperConfig;
}

describe('planAppleContainerInfrastructure', () => {
  it('always includes Squid, the guest\'s only egress path', () => {
    const plan = planAppleContainerInfrastructure(config());
    expect(plan.capabilities.map((entry) => entry.id)).toEqual(['squid']);
    expect(plan.publications).toEqual([
      {
        service: 'squid-proxy',
        containerPort: SQUID_PORT,
        hostPort: SQUID_PORT,
        capability: 'squid',
      },
    ]);
  });

  it('adds the four allowlisted provider ports when the API proxy is enabled', () => {
    const plan = planAppleContainerInfrastructure(config({ enableApiProxy: true }));
    expect(plan.capabilities.map((entry) => entry.id)).toEqual([
      'squid',
      'api-proxy-openai',
      'api-proxy-anthropic',
      'api-proxy-copilot',
      'api-proxy-gemini',
    ]);
    expect(plan.services).toEqual(['squid-proxy', 'api-proxy']);
  });

  it('never publishes the Vertex provider port', () => {
    const plan = planAppleContainerInfrastructure(config({ enableApiProxy: true }));
    const vertex = apiProxyPorts().vertex;
    expect(plan.publications.some((entry) => entry.containerPort === vertex)).toBe(false);
    expect(plan.capabilities.some((entry) => entry.upstream.port === vertex)).toBe(false);
  });

  it('adds the CLI proxy only when a DIFC proxy host is configured', () => {
    expect(planAppleContainerInfrastructure(config()).capabilities.map((e) => e.id))
      .not.toContain('cli-proxy');
    const plan = planAppleContainerInfrastructure(config({ difcProxyHost: 'https://difc:18443' }));
    expect(plan.capabilities.map((entry) => entry.id)).toContain('cli-proxy');
    expect(plan.publications).toContainEqual({
      service: 'cli-proxy',
      containerPort: CLI_PROXY_PORT,
      hostPort: CLI_PROXY_PORT,
      capability: 'cli-proxy',
    });
  });

  it('only ever names capabilities that exist in the layer-2 allowlist', () => {
    const allowed = new Set(APPLE_CONTAINER_TRANSPORT_CAPABILITIES.map((entry) => entry.id));
    const plan = planAppleContainerInfrastructure(
      config({ enableApiProxy: true, difcProxyHost: 'https://difc:18443' }),
    );
    for (const capability of plan.capabilities) {
      expect(allowed.has(capability.id as never)).toBe(true);
    }
  });

  it('dials only loopback IP literals, never a hostname', () => {
    const plan = planAppleContainerInfrastructure(
      config({ enableApiProxy: true, difcProxyHost: 'https://difc:18443' }),
    );
    for (const capability of plan.capabilities) {
      expect(capability.upstream.host).toBe(APPLE_CONTAINER_LOOPBACK_HOST);
    }
  });
});

describe('appleContainerPortMapping', () => {
  it('binds the publication to loopback only', () => {
    const [publication] = planAppleContainerInfrastructure(config()).publications;
    expect(appleContainerPortMapping(publication)).toBe(`127.0.0.1:${SQUID_PORT}:${SQUID_PORT}`);
  });
});

describe('applyAppleContainerLoopbackPublishing', () => {
  it('replaces a wildcard publication rather than adding beside it', () => {
    const services: Record<string, unknown> = {
      'squid-proxy': { ports: [`${SQUID_PORT}:${SQUID_PORT}`] },
    };
    applyAppleContainerLoopbackPublishing(services, planAppleContainerInfrastructure(config()));
    expect((services['squid-proxy'] as { ports: string[] }).ports)
      .toEqual([`127.0.0.1:${SQUID_PORT}:${SQUID_PORT}`]);
  });

  it('groups every provider port onto the api-proxy service', () => {
    const services: Record<string, unknown> = {
      'squid-proxy': {},
      'api-proxy': {},
    };
    applyAppleContainerLoopbackPublishing(
      services,
      planAppleContainerInfrastructure(config({ enableApiProxy: true })),
    );
    const ports = apiProxyPorts();
    expect((services['api-proxy'] as { ports: string[] }).ports).toEqual([
      `127.0.0.1:${ports.openai}:${ports.openai}`,
      `127.0.0.1:${ports.anthropic}:${ports.anthropic}`,
      `127.0.0.1:${ports.copilot}:${ports.copilot}`,
      `127.0.0.1:${ports.gemini}:${ports.gemini}`,
    ]);
  });

  it('fails closed when a required service was not generated', () => {
    expect(() => applyAppleContainerLoopbackPublishing(
      {},
      planAppleContainerInfrastructure(config()),
    )).toThrow('requires the "squid-proxy" Compose service');
  });
});

describe('appleContainerLoopbackPortConflicts', () => {
  it('reports nothing when every port is free', async () => {
    const plan = planAppleContainerInfrastructure(config({ enableApiProxy: true }));
    const conflicts = await appleContainerLoopbackPortConflicts(plan, {
      isPortInUse: async () => false,
    });
    expect(conflicts).toEqual([]);
  });

  it('reports every occupied port so the operator sees the whole conflict', async () => {
    const plan = planAppleContainerInfrastructure(config({ enableApiProxy: true }));
    const conflicts = await appleContainerLoopbackPortConflicts(plan, {
      isPortInUse: async (port) => port === SQUID_PORT || port === apiProxyPorts().copilot,
    });
    expect(conflicts.map((entry) => entry.capability)).toEqual(['squid', 'api-proxy-copilot']);
  });

  it('probes the real loopback address and finds a free port free', async () => {
    const plan = planAppleContainerInfrastructure(config());
    // Uses the default probe against a port nothing is listening on; a live
    // ECONNREFUSED must be reported as "free" rather than as a conflict.
    const conflicts = await appleContainerLoopbackPortConflicts(
      { ...plan, publications: [{ ...plan.publications[0], hostPort: 1, containerPort: 1 }] },
      undefined,
      250,
    );
    expect(conflicts).toEqual([]);
  });
});
