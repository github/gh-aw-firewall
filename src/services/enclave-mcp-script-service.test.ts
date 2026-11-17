import { parseImageTag } from '../image-tag';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { EnclaveMcpBuildResult } from './enclave-mcp-service';
import { buildEnclaveMcpScriptService } from './enclave-mcp-script-service';

const imageConfig = {
  useGHCR: false,
  registry: 'ghcr.io/github/gh-aw-firewall',
  parsedTag: parseImageTag('v1'),
  projectRoot: '/repo',
};

describe('buildEnclaveMcpScriptService', () => {
  it.each(['docker', 'gvisor', 'cloud-hypervisor'] as const)(
    'adds only script configuration for %s without replacing shared state',
    (runtime) => {
      const script = normalizeEnclavesConfig([{
        script: { maxScriptBytes: 4096 },
        runtime,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
        timeout: 12,
      }])!.executors.script;
      const environment: Record<string, string> = { AWF_ENCLAVE_AGENT_ENABLED: 'true' };
      const dependsOn = { 'enclave-agent-api-proxy': { condition: 'service_healthy' } };
      const result: EnclaveMcpBuildResult = { service: {}, agentImageService: { image: 'agent:test' } };

      buildEnclaveMcpScriptService({ script, imageConfig, environment, dependsOn, result });

      expect(environment).toMatchObject({
        AWF_ENCLAVE_AGENT_ENABLED: 'true',
        AWF_ENCLAVE_BACKEND: runtime,
        AWF_ENCLAVE_TIMEOUT: '12',
        AWF_ENCLAVE_MAX_SCRIPT_BYTES: '4096',
      });
      expect(result.agentImageService).toEqual({ image: 'agent:test' });
      expect(dependsOn['enclave-agent-api-proxy']).toEqual({ condition: 'service_healthy' });
      if (runtime === 'cloud-hypervisor') {
        expect(result.scriptImageService).toBeUndefined();
        expect(environment).not.toHaveProperty('AWF_ENCLAVE_IMAGE');
        expect(dependsOn).not.toHaveProperty('enclave-script-image');
      } else {
        expect(result.scriptImageService).toMatchObject({
          image: 'awf-enclave-script:local',
          build: { context: '/repo/containers', dockerfile: 'enclave/Dockerfile', target: 'enclave-script' },
          network_mode: 'none',
          entrypoint: ['/bin/true'],
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          mem_limit: '32m',
          memswap_limit: '32m',
          pids_limit: 16,
          cpu_shares: 64,
          restart: 'no',
        });
        expect(environment.AWF_ENCLAVE_IMAGE).toBe('awf-enclave-script:local');
        expect(dependsOn).toHaveProperty('enclave-script-image', { condition: 'service_completed_successfully' });
      }
      expect(environment.AWF_ENCLAVE_ENTRY_ID).toBe(runtime === 'gvisor' ? undefined : 'script');
    },
  );
});
