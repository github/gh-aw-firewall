import fs from 'fs';
import * as path from 'path';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';
import { buildEnclaveMcpService } from './enclave-mcp-service';
import { generateDockerCompose } from '../compose-generator';
import { resolveEnclavePaths } from '../enclave/paths';
import type { EnclaveRepository, RawEnclaveEntry } from '../types/enclave-options';

const workDir = fs.mkdtempSync('/tmp/awf-enclave-mcp-service-test-');

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    agentCommand: 'echo test',
    allowedDomains: [],
    enclaves: normalizeEnclavesConfig([
      { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]),
    ...overrides,
  } as WrapperConfig;
}

const ghcr = {
  useGHCR: true,
  registry: 'ghcr.io/github/gh-aw-firewall',
  parsedTag: parseImageTag('v1'),
  projectRoot: '/repo',
};

describe('buildEnclaveMcpService', () => {
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('builds a gateway-only no-egress server without exposing it to the primary agent', () => {
    const result = buildEnclaveMcpService({ config: config(), imageConfig: ghcr });
    expect(result.scriptImageService!).toMatchObject({
      image: 'ghcr.io/github/gh-aw-firewall/enclave-script:v1',
      network_mode: 'none',
      entrypoint: ['/bin/true'],
    });
    expect(result.service).toMatchObject({
      container_name: 'awf-enclave-mcp-server',
      image: 'ghcr.io/github/gh-aw-firewall/enclave-mcp-server:v1',
      mem_limit: '1g',
      memswap_limit: '1g',
      depends_on: {
        'enclave-script-image': { condition: 'service_completed_successfully' },
      },
      networks: {
        'awf-enclave-mcp-control': {
          aliases: ['awf-enclave-mcp'],
        },
      },
    });
    expect(result.service).not.toHaveProperty('network_mode');
    expect(result.service).not.toHaveProperty('ports');
    const environment = result.service.environment as Record<string, string>;
    expect(environment.AWF_ENCLAVE_MAX_SCRIPT_BYTES).toBe('65536');
    expect(environment.AWF_ENCLAVE_CAPABILITY_PATH).toBe('/run/awf-enclave-mcp/auth-token');
    expect(Object.keys(environment).some((key) => /TOKEN|REPO|SENSITIVITY/.test(key))).toBe(false);
  });

  it('derives all sandbox controls from trusted configuration', () => {
    const enclaves = normalizeEnclavesConfig([
      {
        script: {
          maxScriptBytes: 4096,
        },
        runtime: 'gvisor',
        memoryLimit: '256m',
        cpuLimit: '0.5',
        pidsLimit: 32,
        tmpfsLimit: '24m',
        maxOutputBytes: 2048,
        maxInvocations: 3,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
        timeout: 12,
      },
    ]);
    const result = buildEnclaveMcpService({
      config: config({ enclaves }),
      imageConfig: ghcr,
    });
    expect(result.service.environment).toMatchObject({
      AWF_ENCLAVE_BACKEND: 'gvisor',
      AWF_ENCLAVE_TIMEOUT: '12',
      AWF_ENCLAVE_MEMORY: '256m',
      AWF_ENCLAVE_CPU: '0.5',
      AWF_ENCLAVE_PIDS: '32',
      AWF_ENCLAVE_TMPFS: '24m',
      AWF_ENCLAVE_MAX_OUTPUT_BYTES: '2048',
      AWF_ENCLAVE_MAX_SCRIPT_BYTES: '4096',
      AWF_ENCLAVE_MAX_INVOCATIONS: '3',
    });
  });

  it('fails closed for the not-yet-proven sbx script runtime', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, runtime: 'sbx', repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
    ]);
    expect(() => buildEnclaveMcpService({ config: config({ enclaves }), imageConfig: ghcr }))
      .toThrow(/sbx script enclave capability is not yet available/);
  });

  it.each(['script', 'agent', 'both'] as const)(
    'routes static Cloud Hypervisor %s only through the private host channel',
    (kind) => {
      const repos: EnclaveRepository[] = [{ repo: 'octo/private', sensitivity: 'internal' }];
      const entries: RawEnclaveEntry[] = [];
      if (kind !== 'agent') entries.push({ script: {}, runtime: 'cloud-hypervisor', repos });
      if (kind !== 'script') {
        entries.push({ agent: { engine: 'copilot', model: 'gpt-4.1' }, runtime: 'cloud-hypervisor', repos });
      }
      const enclaves = normalizeEnclavesConfig(entries);
      const result = buildEnclaveMcpService({
        config: config({ enclaves, enableApiProxy: true }),
        imageConfig: ghcr,
        networkConfig: {
          subnet: '172.30.0.0/24', squidIp: '172.30.0.10', agentIp: '172.30.0.20', proxyIp: '172.30.0.30',
        },
      });
      expect(result.scriptImageService).toBeUndefined();
      expect(result.agentImageService).toBeUndefined();
      const environment = result.service.environment as Record<string, string>;
      expect(environment.AWF_ENCLAVE_IMAGE).toBeUndefined();
      expect(environment.AWF_ENCLAVE_AGENT_IMAGE).toBeUndefined();
      expect(environment.AWF_ENCLAVE_HOST_WORK_DIR).toBeUndefined();
      expect(environment.AWF_ENCLAVE_AGENT_HOST_WORK_DIR).toBeUndefined();
      expect(environment.AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR).toBeUndefined();
      if (kind !== 'agent') expect(environment.AWF_ENCLAVE_ENTRY_ID).toBe('script');
      if (kind !== 'script') {
        expect(environment.AWF_ENCLAVE_AGENT_ENTRY_ID).toBe('agent');
        expect(result.agentApiProxyService).toBeDefined();
      }
      const paths = resolveEnclavePaths(workDir);
      const volumes = result.service.volumes as string[];
      expect(volumes).toContain(
        `${paths.hostExecutorDir}:/run/awf-enclave-host-executor:ro`,
      );
      expect(volumes.some((volume) => volume.includes('docker.sock'))).toBe(false);
      expect(volumes.some((volume) => volume.startsWith(`${paths.seedsDir}:`))).toBe(false);
      expect(volumes.some((volume) => volume.startsWith(`${paths.workDir}:`))).toBe(false);
      expect(volumes.some((volume) => volume.startsWith(`${paths.hostExecutorJournalDir}:`))).toBe(false);
      expect(volumes).toContain(`${paths.seedMapPath}:/srv/awf/seed-map.json:ro`);
    },
  );

  it('rejects mixed Cloud Hypervisor and container enclave runtimes', () => {
    const repos: EnclaveRepository[] = [{ repo: 'octo/private', sensitivity: 'internal' }];
    const enclaves = normalizeEnclavesConfig([
      { script: {}, runtime: 'cloud-hypervisor', repos },
      { agent: { engine: 'copilot', model: 'gpt-4.1' }, runtime: 'docker', repos },
    ]);
    expect(() => buildEnclaveMcpService({
      config: config({ enclaves, enableApiProxy: true }), imageConfig: ghcr,
    })).toThrow(/cannot be mixed/);
  });

  it.each(['script', 'agent'] as const)('rejects a custom %s image for Cloud Hypervisor', (kind) => {
    const repos: EnclaveRepository[] = [{ repo: 'octo/private', sensitivity: 'internal' }];
    const entry: RawEnclaveEntry = kind === 'script'
      ? { script: {}, runtime: 'cloud-hypervisor', image: 'custom:latest', repos }
      : { agent: { engine: 'copilot', model: 'gpt-4.1' }, runtime: 'cloud-hypervisor', image: 'custom:latest', repos };
    expect(() => buildEnclaveMcpService({
      config: config({ enclaves: normalizeEnclavesConfig([entry]), enableApiProxy: true }),
      imageConfig: ghcr,
    })).toThrow(/static entries and release-attested artifacts/);
  });

  it('assembles the service without primary-agent mounts or dependency wiring', () => {
    // generateDockerCompose materializes a chroot hosts stage under the work
    // directory, so this assertion needs a real one.
    const workDir = fs.mkdtempSync(path.join(__dirname, 'awf-enclave-script-compose-'));
    let compose;
    try {
      compose = generateDockerCompose(config({
        workDir,
        agentCommand: 'echo enclave',
        allowedDomains: [],
      } as Partial<WrapperConfig>), {
        subnet: '172.30.0.0/24',
        squidIp: '172.30.0.10',
        agentIp: '172.30.0.20',
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    expect(compose.services['enclave-script-image']).toBeDefined();
    expect(compose.services['enclave-mcp-server']).toBeDefined();
    expect(compose.networks['awf-enclave-mcp-control']).toMatchObject({
      name: 'awf-enclave-mcp-control',
      internal: true,
    });
    const agent = compose.services.agent as unknown as Record<string, unknown>;
    expect((agent.depends_on as Record<string, unknown>)['enclave-mcp-server']).toBeUndefined();
    expect(JSON.stringify(agent.volumes)).not.toContain('awf-enclave-control');
    expect(JSON.stringify(agent.environment)).not.toContain('AWF_ENCLAVE');
    expect(JSON.stringify(agent)).not.toContain('awf-enclave-mcp');
    expect(JSON.stringify((agent as { networks?: unknown }).networks)).not.toContain(
      'awf-enclave-mcp-control',
    );
  });
});
