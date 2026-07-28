import * as path from 'path';
import type { SealedProbesConfig, WrapperConfig } from '../types';
import { parseImageTag } from '../image-tag';
import { AGENT_SKILL_DIR, AGENT_SOCKET_DIR, AGENT_SOCKET_PATH, resolveSealedProbePaths } from '../sealed-probe/paths';
import {
  buildSealedProbeService,
  isSealedProbeAgentMount,
  sealedProbeServiceTestHelpers,
} from './sealed-probe-service';
import type { ImageBuildConfig } from './squid-service';

const WORK_DIR = '/tmp/awf-1700000000';

const sealedProbes: SealedProbesConfig = {
  enabled: true,
  privateRepos: ['octo/alpha', 'octo/beta'],
  runtime: 'docker',
  timeout: 45,
  memoryLimit: '256m',
  interpreter: 'python3',
  maxInvocations: 9,
};

function buildConfig(overrides: Partial<WrapperConfig> = {}, probes: Partial<SealedProbesConfig> = {}): WrapperConfig {
  return {
    workDir: WORK_DIR,
    sealedProbes: { ...sealedProbes, ...probes },
    ...overrides,
  } as unknown as WrapperConfig;
}

function imageConfig(useGHCR = true): ImageBuildConfig {
  return {
    useGHCR,
    registry: 'ghcr.io/github/gh-aw-firewall',
    parsedTag: parseImageTag('v1.2.3'),
    projectRoot: '/opt/awf',
  };
}

const paths = resolveSealedProbePaths(WORK_DIR);

describe('buildSealedProbeService', () => {
  it('refuses to build when sealed probes are not enabled', () => {
    expect(() =>
      buildSealedProbeService({ config: buildConfig({}, { enabled: false }), imageConfig: imageConfig() }),
    ).toThrow(/must be enabled/);
  });

  describe('broker service', () => {
    const { probeImageService, service } = buildSealedProbeService({
      config: buildConfig(),
      imageConfig: imageConfig(),
    });
    const volumes = service.volumes as string[];
    const environment = service.environment as Record<string, string>;

    it('has no network at all — not awf-net, not the external bridge', () => {
      expect(service.network_mode).toBe('none');
      expect(service).not.toHaveProperty('networks');
      expect(service).not.toHaveProperty('dns');
      expect(service).not.toHaveProperty('extra_hosts');
      expect(service).not.toHaveProperty('ports');
    });

    it('mounts the broker socket directory read-write so the agent can connect', () => {
      expect(volumes).toContain(`${paths.runDir}:/run/awf-sealed-probe:rw`);
    });

    it('mounts the seeds read-only and the seed map read-only', () => {
      expect(volumes).toContain(`${paths.seedsDir}:/srv/awf/seeds:ro`);
      expect(volumes).toContain(`${paths.seedMapPath}:/srv/awf/seed-map.json:ro`);
    });

    it('mounts the Docker socket so it can launch probes', () => {
      expect(volumes).toContain('/var/run/docker.sock:/var/run/docker.sock:rw');
    });

    it('keeps protected diagnostics on a broker-only mount', () => {
      expect(volumes).toContain(`${paths.auditDir}:/var/log/awf-sealed-probe:rw`);
    });

    it('mounts nothing else', () => {
      expect(volumes).toHaveLength(6);
    });

    it('passes only AWF-chosen limits and the resolved probe image', () => {
      expect(environment.AWF_SEALED_PROBE_IMAGE).toBe('ghcr.io/github/gh-aw-firewall/sealed-probe:v1.2.3');
      expect(environment.AWF_SEALED_PROBE_TIMEOUT).toBe('45');
      expect(environment.AWF_SEALED_PROBE_MEMORY).toBe('256m');
      expect(environment.AWF_SEALED_PROBE_MAX_INVOCATIONS).toBe('9');
      expect(environment.AWF_SEALED_PROBE_RUNTIME).toBe('');
      expect(environment.AWF_SEALED_PROBE_HOST_WORK_DIR).toBe(paths.workDir);
    });

    it('carries no credential in its environment', () => {
      expect(Object.keys(environment).join(' ')).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/i);
    });

    it('is hardened and health-gated', () => {
      expect(service.cap_drop).toEqual(['ALL']);
      expect(service.cap_add).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
      expect(service.security_opt).toEqual(['no-new-privileges:true']);
      expect(service.mem_limit).toBe('256m');
      expect(service.pids_limit).toBe(100);
      expect((service.healthcheck as { test: string[] }).test).toEqual([
        'CMD',
        'node',
        '/opt/awf/broker/healthcheck.js',
      ]);
    });

    it('waits for a networkless one-shot service to make the probe image available', () => {
      expect(service.depends_on).toEqual({
        'sealed-probe-image': { condition: 'service_completed_successfully' },
      });
      expect(probeImageService).toMatchObject({
        image: 'ghcr.io/github/gh-aw-firewall/sealed-probe:v1.2.3',
        network_mode: 'none',
        entrypoint: ['/bin/true'],
        cap_drop: ['ALL'],
        restart: 'no',
      });
      expect(probeImageService).not.toHaveProperty('volumes');
    });

    it('maps the gvisor runtime to the runsc OCI runtime for probes', () => {
      const { service: gvisorService } = buildSealedProbeService({
        config: buildConfig({}, { runtime: 'gvisor' }),
        imageConfig: imageConfig(),
      });
      expect((gvisorService.environment as Record<string, string>).AWF_SEALED_PROBE_RUNTIME).toBe('runsc');
    });

    it('uses the AWF Docker host socket when overridden, without leaking it to the agent', () => {
      const result = buildSealedProbeService({
        config: buildConfig({ awfDockerHost: 'unix:///run/user/1001/docker.sock' }),
        imageConfig: imageConfig(),
      });
      expect(result.service.volumes as string[]).toContain(
        '/run/user/1001/docker.sock:/var/run/docker.sock:rw',
      );
      expect(JSON.stringify(result.agentEnvAdditions)).not.toContain('docker.sock');
      expect(result.agentVolumes.join(' ')).not.toContain('docker.sock');
    });

    it('pins a deterministic local image tag when building from source', () => {
      const { probeImageService: localProbeService, service: localService } = buildSealedProbeService({
        config: buildConfig(),
        imageConfig: imageConfig(false),
      });

      expect(localService.image).toBe('awf-sealed-probe-broker:local');
      expect(localService.build).toEqual({
        context: path.join('/opt/awf', 'containers', 'sealed-probe'),
        dockerfile: 'Dockerfile',
        target: 'broker',
      });
      expect((localService.environment as Record<string, string>).AWF_SEALED_PROBE_IMAGE)
        .toBe('awf-sealed-probe:local');
      expect(localProbeService).toMatchObject({
        image: 'awf-sealed-probe:local',
        build: {
          context: path.join('/opt/awf', 'containers', 'sealed-probe'),
          dockerfile: 'Dockerfile',
          target: 'probe',
        },
        entrypoint: ['/bin/true'],
      });
    });

    it('keeps the legacy image helper aligned with the split image resolver', () => {
      expect(sealedProbeServiceTestHelpers.resolveSealedProbeImage(imageConfig())).toEqual({
        imageRef: 'ghcr.io/github/gh-aw-firewall/sealed-probe:v1.2.3',
        source: { image: 'ghcr.io/github/gh-aw-firewall/sealed-probe-broker:v1.2.3' },
      });
    });
  });

  describe('agent wiring', () => {
    const { agentEnvAdditions, agentVolumes } = buildSealedProbeService({
      config: buildConfig(),
      imageConfig: imageConfig(),
    });

    it('exposes only the socket path, skill path, and repository list', () => {
      expect(agentEnvAdditions).toEqual({
        AWF_SEALED_PROBE_SOCKET: AGENT_SOCKET_PATH,
        AWF_SEALED_PROBE_SKILL: '/run/awf-sealed-probe-skill/SKILL.md',
        AWF_SEALED_PROBE_REPOS: 'octo/alpha,octo/beta',
      });
    });

    it('mounts the socket read-write and the skill read-only, for chroot and non-chroot paths', () => {
      expect(agentVolumes).toEqual([
        // Masking mounts first — hide the sealed-probe root visible through /tmp.
        `${paths.maskDir}:${paths.root}:ro`,
        `${paths.maskDir}:/host${paths.root}:ro`,
        // Socket mounts.
        `${paths.runDir}:${AGENT_SOCKET_DIR}:rw`,
        `${paths.runDir}:/host${AGENT_SOCKET_DIR}:rw`,
        // Skill mounts.
        `${paths.agentDir}:${AGENT_SKILL_DIR}:ro`,
        `${paths.agentDir}:/host${AGENT_SKILL_DIR}:ro`,
      ]);
    });

    it('never mounts the seeds, the broker work directory, or the audit log into the agent', () => {
      const joined = agentVolumes.join(' ');
      expect(joined).not.toContain(paths.seedsDir);
      expect(joined).not.toContain(paths.workDir);
      expect(joined).not.toContain(paths.auditDir);
      expect(joined).not.toContain(paths.seedMapPath);
    });
  });

  describe('ARC/DinD host path translation', () => {
    const { service, agentVolumes } = buildSealedProbeService({
      config: buildConfig({ dockerHostPathPrefix: '/host' }),
      imageConfig: imageConfig(),
    });

    it('prefixes broker bind-mount sources so the daemon can resolve them', () => {
      expect(service.volumes as string[]).toContain(`/host${paths.seedsDir}:/srv/awf/seeds:ro`);
      expect(service.volumes as string[]).toContain('/host/var/run/docker.sock:/var/run/docker.sock:rw');
    });

    it('prefixes the agent socket and skill mounts symmetrically', () => {
      // Masking mounts are at [0] and [1]; socket mounts start at [2].
      expect(agentVolumes[2]).toBe(`/host${paths.runDir}:${AGENT_SOCKET_DIR}:rw`);
      expect(agentVolumes[4]).toBe(`/host${paths.agentDir}:${AGENT_SKILL_DIR}:ro`);
    });

    it('hands the daemon-visible work directory to the broker for probe mounts', () => {
      expect((service.environment as Record<string, string>).AWF_SEALED_PROBE_HOST_WORK_DIR)
        .toBe(`/host${paths.workDir}`);
    });
  });
});

describe('isSealedProbeAgentMount', () => {
  it('recognises the socket and skill mounts in both chroot spellings', () => {
    expect(isSealedProbeAgentMount(`${paths.runDir}:${AGENT_SOCKET_DIR}:rw`)).toBe(true);
    expect(isSealedProbeAgentMount(`${paths.runDir}:/host${AGENT_SOCKET_DIR}:rw`)).toBe(true);
    expect(isSealedProbeAgentMount(`${paths.agentDir}:${AGENT_SKILL_DIR}:ro`)).toBe(true);
    expect(isSealedProbeAgentMount(`${paths.agentDir}:/host${AGENT_SKILL_DIR}:ro`)).toBe(true);
  });

  it('does not match unrelated mounts', () => {
    expect(isSealedProbeAgentMount('/tmp:/host/tmp:rw')).toBe(false);
    expect(isSealedProbeAgentMount(`${paths.seedsDir}:/host/seeds:ro`)).toBe(false);
    expect(isSealedProbeAgentMount('malformed')).toBe(false);
  });
});
