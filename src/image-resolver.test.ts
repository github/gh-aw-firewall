import { resolveRuntimeImage, validateCustomImageManifest } from './image-resolver';
import { parseImageTag } from './image-tag';
import type { WrapperConfig } from './types';
import { validateAwfFileConfig } from './config-file';

const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const image = (name: string) => `registry.example.com/approved/${name}:v1@${digest}`;
const config = (images?: WrapperConfig['images']): WrapperConfig => ({
  images,
  workDir: '/tmp/awf-test',
  allowedDomains: [],
  agentCommand: 'true',
  logLevel: 'error',
  keepContainers: false,
});

describe('custom runtime image manifest', () => {
  it('resolves only the digest-pinned configured image', () => {
    const result = resolveRuntimeImage(
      config({ squid: image('squid') }),
      'squid',
      'ghcr.io/github/gh-aw-firewall',
      parseImageTag('latest'),
    );
    expect(result).toBe(image('squid'));
  });

  it('fails closed when an enabled role is absent', () => {
    expect(() => resolveRuntimeImage(
      config({ squid: image('squid') }),
      'agent',
      'ghcr.io/github/gh-aw-firewall',
      parseImageTag('latest'),
    )).toThrow('must include "agent"');
  });

  it.each([
    'registry.example.com/approved/squid:v1',
    'registry.example.com/approved/squid:v1@$sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'registry.example.com/approved/squid:v1@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'registry.example.com/approved/squid:v1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa extra',
  ])('rejects unsafe or mutable references: %s', (reference) => {
    expect(() => validateCustomImageManifest(config({ squid: reference }))).toThrow(
      'expected a literal tag@sha256',
    );
  });

  it('rejects local builds and enclave overrides with a manifest', () => {
    expect(() => validateCustomImageManifest({
      ...config({ squid: image('squid') }),
      buildLocal: true,
    })).toThrow('buildLocal');
  });

  it('rejects legacy image controls in file configuration', () => {
    expect(validateAwfFileConfig({
      container: {
        images: { squid: image('squid') },
        imageRegistry: 'registry.example.com/approved',
      },
    }).join('\n')).toContain('must NOT be valid');
  });
});
