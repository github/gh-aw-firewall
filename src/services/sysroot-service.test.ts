import { parseImageTag } from '../image-tag';
import { WrapperConfig } from '../types';
import {
  buildSysrootStageService,
  DEFAULT_SYSROOT_IMAGE,
  isSysrootTopologyEnabled,
  resolveSysrootImage,
} from './sysroot-service';

const baseConfig: WrapperConfig = {
  allowedDomains: ['github.com'],
  agentCommand: 'echo hi',
  logLevel: 'info',
  keepContainers: false,
  workDir: '/tmp/awf-test',
  imageRegistry: 'ghcr.io/github/gh-aw-firewall',
  imageTag: 'latest',
  buildLocal: false,
};

const imageConfig = {
  useGHCR: true,
  registry: 'ghcr.io/github/gh-aw-firewall',
  parsedTag: parseImageTag('latest'),
  projectRoot: '/tmp/project',
};

describe('sysroot-service', () => {
  it('enables sysroot topology only for arc-dind', () => {
    expect(isSysrootTopologyEnabled(baseConfig)).toBe(false);
    expect(isSysrootTopologyEnabled({ ...baseConfig, runnerTopology: 'arc-dind' })).toBe(true);
  });

  it('resolves default build-tools image from registry/tag', () => {
    expect(resolveSysrootImage({ ...baseConfig, runnerTopology: 'arc-dind' }, imageConfig))
      .toBe(DEFAULT_SYSROOT_IMAGE);
  });

  it('prefers explicit runnerSysrootImage override', () => {
    expect(resolveSysrootImage({
      ...baseConfig,
      runnerTopology: 'arc-dind',
      runnerSysrootImage: 'ghcr.io/custom/build-tools:v1',
    }, imageConfig)).toBe('ghcr.io/custom/build-tools:v1');
  });

  it('builds a sysroot-stage one-shot service', () => {
    const service = buildSysrootStageService({ ...baseConfig, runnerTopology: 'arc-dind' }, imageConfig);
    expect(service.image).toBe(DEFAULT_SYSROOT_IMAGE);
    expect(service.volumes).toEqual(['sysroot:/sysroot']);
    expect(service.restart).toBe('no');
  });
});
