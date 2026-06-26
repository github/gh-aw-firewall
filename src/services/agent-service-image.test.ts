import { testHelpers } from './agent-service.test-utils';
import { parseImageTag } from '../image-tag';
import * as path from 'path';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const nodePath = path;
const { resolveAgentImageConfig } = testHelpers;

describe('resolveAgentImageConfig', () => {
  const projectRoot = '/fake/project';
  const registry = 'ghcr.io/github/gh-aw-firewall';
  const parsedTag = parseImageTag('latest');

  const baseImageConfig = { useGHCR: true, registry, parsedTag, projectRoot };

  it('returns GHCR agent image for default preset', () => {
    const result = resolveAgentImageConfig(
      { agentImage: 'default', buildLocal: false } as any,
      baseImageConfig,
    );
    expect(result).toEqual({ image: 'ghcr.io/github/gh-aw-firewall/agent:latest' });
  });

  it('returns GHCR agent-act image for act preset', () => {
    const result = resolveAgentImageConfig(
      { agentImage: 'act', buildLocal: false } as any,
      baseImageConfig,
    );
    expect(result).toEqual({ image: 'ghcr.io/github/gh-aw-firewall/agent-act:latest' });
  });

  it('returns build config for default preset with --build-local', () => {
    const result = resolveAgentImageConfig(
      { agentImage: 'default', buildLocal: true } as any,
      { ...baseImageConfig, useGHCR: false },
    ) as any;
    expect(result.build).toBeDefined();
    expect(result.build.dockerfile).toBe('Dockerfile');
    expect(result.build.context).toBe(nodePath.join(projectRoot, 'containers/agent'));
    expect(result.build.args.BASE_IMAGE).toBeUndefined();
    expect(result.image).toBeUndefined();
  });

  it('returns build config for act preset with --build-local', () => {
    const result = resolveAgentImageConfig(
      { agentImage: 'act', buildLocal: true } as any,
      { ...baseImageConfig, useGHCR: false },
    ) as any;
    expect(result.build).toBeDefined();
    expect(result.build.args.BASE_IMAGE).toMatch(/catthehacker/);
  });

  it('returns build config with BASE_IMAGE for custom (non-preset) image', () => {
    const result = resolveAgentImageConfig(
      { agentImage: 'ubuntu:24.04', buildLocal: false } as any,
      { ...baseImageConfig, useGHCR: false },
    ) as any;
    expect(result.build).toBeDefined();
    expect(result.build.args.BASE_IMAGE).toBe('ubuntu:24.04');
  });

  it('returns direct image passthrough when useGHCR is false, buildLocal is false, and preset image is specified', () => {
    // Else branch fires when: !useGHCR && !buildLocal && isPreset
    // (e.g. user disabled GHCR pull but did not pass --build-local, using the 'default' preset)
    const result = resolveAgentImageConfig(
      { agentImage: 'default', buildLocal: false } as any,
      { ...baseImageConfig, useGHCR: false },
    ) as any;
    expect(result.image).toBe('default');
    expect(result.build).toBeUndefined();
  });
});
