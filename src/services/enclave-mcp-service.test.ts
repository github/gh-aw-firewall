import fs from 'fs';
import * as path from 'path';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { parseImageTag } from '../image-tag';
import type { WrapperConfig } from '../types';
import { buildEnclaveMcpService } from './enclave-mcp-service';
import { generateDockerCompose } from '../compose-generator';

const workDir = fs.mkdtempSync('/tmp/awf-enclave-mcp-service-test-');

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    workDir,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    agentCommand: 'echo test',
    allowedDomains: [],
    enclaves: normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { script: { enabled: true } },
    }),
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
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: {
        script: {
          enabled: true,
          runtime: 'gvisor',
          timeout: 12,
          memoryLimit: '256m',
          cpuLimit: '0.5',
          pidsLimit: 32,
          tmpfsLimit: '24m',
          maxOutputBytes: 2048,
          maxScriptBytes: 4096,
          maxInvocations: 3,
        },
      },
    });
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
    const enclaves = normalizeEnclavesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      executors: { script: { enabled: true, runtime: 'sbx' } },
    });
    expect(() => buildEnclaveMcpService({ config: config({ enclaves }), imageConfig: ghcr }))
      .toThrow(/sbx script enclave capability is not yet available/);
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
