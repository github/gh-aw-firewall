import {
  collectResolvedRuntimeImages,
  resetRuntimeImageLedger,
  resolveDindStagingImage,
  resolveDohProxyImage,
  resolveRuntimeImage,
  validateCustomImageManifest,
} from './image-resolver';
import * as imageResolverExports from './image-resolver';
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
  beforeEach(() => {
    resetRuntimeImageLedger();
  });

  it('keeps default image constants internal to the resolver', () => {
    expect(imageResolverExports).not.toHaveProperty('DEFAULT_IMAGE_REGISTRY');
    expect(imageResolverExports).not.toHaveProperty('DEFAULT_DIND_STAGING_IMAGE');
    expect(imageResolverExports).not.toHaveProperty('DEFAULT_DOH_PROXY_IMAGE');
  });

  it('keeps digest-pinned image validation internals private', () => {
    expect(imageResolverExports).not.toHaveProperty('DIGEST_PINNED_IMAGE_PATTERN');
    expect(imageResolverExports).not.toHaveProperty('isDigestPinnedImageReference');
  });

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
    `registry.example.com/approved/squid:v1@$${digest}`,
    'registry.example.com/approved/squid:v1@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    `registry.example.com/approved/squid:v1@${digest} extra`,
    // Empty registry port: accepted by a permissive pattern, rejected by the
    // distribution reference grammar.
    `registry.example.com:/approved/squid:v1@${digest}`,
    // Invalid repository separator sequences.
    `registry.example.com/approved-/squid:v1@${digest}`,
    `registry.example.com/approved..squid:v1@${digest}`,
    // Implicit Docker Hub namespace (no explicit registry host).
    `approved/squid:v1@${digest}`,
  ])('rejects unsafe or mutable references: %s', (reference) => {
    expect(() => validateCustomImageManifest(config({ squid: reference }))).toThrow(
      'tag@sha256:<64-hex> OCI reference',
    );
  });

  it.each([
    `registry.example.com:5000/approved/squid:v1@${digest}`,
    `localhost:5000/approved/squid:v1@${digest}`,
    `registry.example.com/approved/nested/squid_image:v1.2.3-rc1@${digest}`,
  ])('accepts registry-qualified pinned references: %s', (reference) => {
    expect(() => validateCustomImageManifest(config({ squid: reference }))).not.toThrow();
  });

  it('rejects local builds with a manifest', () => {
    expect(() => validateCustomImageManifest({
      ...config({ squid: image('squid') }),
      buildLocal: true,
    })).toThrow('buildLocal');
  });

  it.each([
    ['sslBump', { sslBump: true }],
    ['agentImage', { agentImage: 'act' }],
    ['sysrootImage', { sysrootImage: 'registry.example.com/other/build-tools:v1' }],
  ])('rejects the ambiguous %s control with a manifest', (expected, overrides) => {
    expect(() => validateCustomImageManifest({
      ...config({ squid: image('squid') }),
      ...overrides,
    })).toThrow(expected);
  });

  it('rejects legacy image controls in file configuration', () => {
    expect(validateAwfFileConfig({
      container: {
        images: { squid: image('squid') },
        imageRegistry: 'registry.example.com/approved',
      },
    }).join('\n')).toContain('must NOT be valid');
  });

  it('routes the DNS-over-HTTPS sidecar through the manifest', () => {
    expect(resolveDohProxyImage(config({ dohProxy: image('cloudflared') })))
      .toBe(image('cloudflared'));
    expect(() => resolveDohProxyImage(config({ squid: image('squid') })))
      .toThrow('must include "dohProxy"');
    expect(resolveDohProxyImage(config())).toBe('cloudflare/cloudflared:latest');
  });

  it('records non-Compose consumers in the audit manifest', () => {
    const manifest = {
      ...config({ squid: image('squid'), dindStaging: image('agent') }),
      dind: { preStageDirs: true },
    };
    resolveRuntimeImage(manifest, 'squid', 'ghcr.io/github/gh-aw-firewall', parseImageTag('latest'));

    expect(collectResolvedRuntimeImages(manifest)).toEqual({
      squid: { image: image('squid'), source: 'explicit' },
      dindStaging: { image: image('agent'), source: 'explicit' },
    });
  });

  it('records the legacy DinD staging image without a manifest', () => {
    const legacy = { ...config(), dind: { preStageDirs: true } };
    expect(resolveDindStagingImage(legacy)).toBe('ghcr.io/github/gh-aw-firewall/agent:latest');
    expect(collectResolvedRuntimeImages(legacy)).toEqual({
      dindStaging: { image: 'ghcr.io/github/gh-aw-firewall/agent:latest', source: 'default' },
    });
  });
});
