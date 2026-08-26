/**
 * End-to-end coverage for `appleContainer.mcpGatewayUpstreamPort`.
 *
 * The option exists so a caller such as gh-aw, which starts an ordinary MCP
 * gateway outside the AWF Compose project and binds it to macOS loopback, can
 * hand AWF just a port number. Everything else about the path is fixed by AWF:
 * the upstream host, the guest port, the socket name, and the requirement that
 * the upstream is actually listening before the agent starts.
 *
 * These tests cover the configuration surface (CLI parsing, config-file
 * mapping, JSON Schema) and the misuse cases. Planning, Compose behaviour, and
 * transport readiness are covered in
 * `src/apple-container/infrastructure-endpoints.test.ts` and
 * `src/apple-container/transport-manager.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

import Ajv2020 from 'ajv/dist/2020';

import { buildConfig } from './commands/build-config';
import { mapAwfFileConfigToCliOptions } from './config-mapper';
import {
  assertAppleContainerRuntimeCompatibility,
  assertAppleContainerSelection,
} from './apple-container/runtime-validation';
import type { AwfFileConfig } from './config-file';
import type { WrapperConfig } from './types';

function inputs(options: Record<string, unknown> = {}): Parameters<typeof buildConfig>[0] {
  return {
    options: {
      keepContainers: false,
      tty: false,
      workDir: '/tmp/awf-test',
      buildLocal: false,
      skipPull: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      envAll: false,
      enableHostAccess: false,
      sslBump: false,
      enableDind: false,
      enableDlp: false,
      enableApiProxy: false,
      anthropicAutoCache: false,
      diagnosticLogs: false,
      ...options,
    },
    agentCommand: 'echo hello',
    logLevel: 'info',
    allowedDomains: ['github.com'],
    blockedDomains: [],
    localhostDetected: false,
    additionalEnv: {},
    volumeMounts: undefined,
    upstreamProxy: undefined,
    dnsServers: ['8.8.8.8'],
    dnsOverHttps: undefined,
    allowedUrls: undefined,
    memoryLimit: undefined,
    pidsLimit: undefined,
    agentImage: undefined,
    modelAliases: undefined,
    allowedModels: undefined,
    disallowedModels: undefined,
    maxEffectiveTokens: undefined,
    maxAiCredits: undefined,
    effectiveTokenModelMultipliers: undefined,
    effectiveTokenDefaultModelMultiplier: undefined,
    maxRuns: undefined,
    maxPermissionDenied: undefined,
    maxCacheMisses: undefined,
    resolvedCopilotApiTarget: undefined,
    resolvedCopilotApiBasePath: undefined,
    dockerHostPathPrefix: undefined,
  } as unknown as Parameters<typeof buildConfig>[0];
}

describe('--apple-container-mcp-gateway-upstream-port parsing', () => {
  it('parses a valid port onto the Apple Container config', () => {
    const config = buildConfig(inputs({
      containerRuntime: 'apple-container',
      appleContainerPreview: true,
      appleContainerMcpGatewayUpstreamPort: '9100',
    }));
    expect(config.appleContainer?.mcpGatewayUpstreamPort).toBe(9100);
  });

  it('leaves the field absent when the flag is not passed', () => {
    const config = buildConfig(inputs({
      containerRuntime: 'apple-container',
      appleContainerPreview: true,
    }));
    expect(config.appleContainer).toBeDefined();
    expect(config.appleContainer).not.toHaveProperty('mcpGatewayUpstreamPort');
  });

  it('materialises Apple Container config when only this flag is passed', () => {
    // Otherwise the option would be silently dropped and the misuse guard in
    // runtime-validation would never see it.
    const config = buildConfig(inputs({ appleContainerMcpGatewayUpstreamPort: '9100' }));
    expect(config.appleContainer?.mcpGatewayUpstreamPort).toBe(9100);
  });

  it.each(['0', '65536', '-1', '1.5', 'nine', '', '0x10', '9100abc'])(
    'rejects the invalid port %p',
    (value) => {
      expect(() => buildConfig(inputs({
        containerRuntime: 'apple-container',
        appleContainerPreview: true,
        appleContainerMcpGatewayUpstreamPort: value,
      }))).toThrow('--apple-container-mcp-gateway-upstream-port must be an integer TCP port');
    },
  );

  it.each(['1', '65535'])('accepts the boundary port %p', (value) => {
    const config = buildConfig(inputs({
      containerRuntime: 'apple-container',
      appleContainerPreview: true,
      appleContainerMcpGatewayUpstreamPort: value,
    }));
    expect(config.appleContainer?.mcpGatewayUpstreamPort).toBe(Number(value));
  });
});

describe('config-file mapping', () => {
  it('maps appleContainer.mcpGatewayUpstreamPort onto the CLI option', () => {
    const options = mapAwfFileConfigToCliOptions({
      container: { containerRuntime: 'apple-container' },
      appleContainer: { previewEnabled: true, mcpGatewayUpstreamPort: 9100 },
    } as AwfFileConfig);
    expect(options.appleContainerMcpGatewayUpstreamPort).toBe('9100');
  });

  it('omits the option when the config file does not set it', () => {
    const options = mapAwfFileConfigToCliOptions({
      appleContainer: { previewEnabled: true },
    } as AwfFileConfig);
    expect(options.appleContainerMcpGatewayUpstreamPort).toBeUndefined();
  });

  it('round-trips a config file value into the assembled config', () => {
    const mapped = mapAwfFileConfigToCliOptions({
      container: { containerRuntime: 'apple-container' },
      appleContainer: { previewEnabled: true, mcpGatewayUpstreamPort: 9100 },
    } as AwfFileConfig);
    const config = buildConfig(inputs({ ...mapped }));
    expect(config.appleContainer?.mcpGatewayUpstreamPort).toBe(9100);
  });
});

describe('awf-config.schema.json', () => {
  const schemaPath = path.join(__dirname, '..', 'docs', 'awf-config.schema.json');
  let validate: ReturnType<Ajv2020['compile']>;

  beforeAll(() => {
    const ajv = new Ajv2020({ allErrors: true });
    ajv.addKeyword({ keyword: 'version' });
    validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
  });

  it('accepts an in-range port', () => {
    expect(validate({ appleContainer: { previewEnabled: true, mcpGatewayUpstreamPort: 9100 } }))
      .toBe(true);
  });

  it.each([0, 65_536, 1.5, '9100', null])('rejects %p', (value) => {
    expect(validate({ appleContainer: { mcpGatewayUpstreamPort: value } })).toBe(false);
  });

  it('offers no companion host/address setting', () => {
    // The upstream host is pinned to 127.0.0.1 in code; a configurable host
    // would widen the set of addresses AWF is willing to dial from the relay.
    expect(validate({ appleContainer: { mcpGatewayUpstreamHost: '10.0.0.5' } })).toBe(false);
  });

  it('matches the bundled runtime copy of the schema', () => {
    const bundled = fs.readFileSync(path.join(__dirname, 'awf-config-schema.json'), 'utf8');
    const docs = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    const runtime = JSON.parse(bundled) as Record<string, unknown>;
    expect((runtime.properties as Record<string, unknown>).appleContainer)
      .toEqual((docs.properties as Record<string, unknown>).appleContainer);
  });
});

describe('runtime compatibility', () => {
  function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
    return {
      allowedDomains: ['github.com'],
      agentCommand: 'true',
      logLevel: 'info',
      workDir: '/tmp/awf-test',
      containerRuntime: 'apple-container',
      networkIsolation: true,
      appleContainer: {
        previewEnabled: true,
        cpus: 4,
        memory: '8G',
        mcpGatewayUpstreamPort: 9100,
      },
      ...overrides,
    } as unknown as WrapperConfig;
  }

  it('accepts the option on the Apple Container runtime with preview enabled', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config())).not.toThrow();
  });

  it('rejects the option on another runtime with an actionable message', () => {
    expect(() => assertAppleContainerSelection(config({ containerRuntime: 'gvisor' })))
      .toThrow(/mcpGatewayUpstreamPort .*requires --container-runtime apple-container/s);
  });

  it('rejects the option on the default Docker runtime', () => {
    expect(() => assertAppleContainerSelection(config({ containerRuntime: undefined })))
      .toThrow('mcpGatewayUpstreamPort');
  });

  it('still requires the preview opt-in', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config({
      appleContainer: {
        previewEnabled: false,
        cpus: 4,
        memory: '8G',
        mcpGatewayUpstreamPort: 9100,
      },
    }))).toThrow('requires explicit --apple-container-preview opt-in');
  });

  it('re-validates a port injected past the CLI parser', () => {
    // A config file or programmatic caller can populate appleContainer directly.
    expect(() => assertAppleContainerRuntimeCompatibility(config({
      appleContainer: {
        previewEnabled: true,
        cpus: 4,
        memory: '8G',
        mcpGatewayUpstreamPort: 70_000,
      },
    }))).toThrow('mcpGatewayUpstreamPort must be an integer TCP port in 1..65535');
  });

  it('keeps rejecting enclaves even with the gateway port configured', () => {
    // The ordinary MCP gateway is not enclave support; enabling enclaves must
    // still fail closed.
    expect(() => assertAppleContainerRuntimeCompatibility(config({
      enclaves: { enabled: true },
    } as unknown as Partial<WrapperConfig>)))
      .toThrow('does not yet support enclaves');
  });

  it('keeps rejecting topology attach even with the gateway port configured', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config({
      topologyAttach: ['awmg-mcpg'],
    }))).toThrow('does not support --topology-attach');
  });
});
