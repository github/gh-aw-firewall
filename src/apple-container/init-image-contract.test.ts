/**
 * Contract check for the AWF Apple init image build.
 *
 * The init image is where the guest half of the transport actually ships, and
 * it encodes three things that must agree with the compiled-in host contract:
 * where Apple's real `vminitd` is relocated to, where the shim is installed,
 * and which `container` CLI range the result is valid for. A drift in any of
 * them would not fail a build — it would produce a VM that boots without
 * capabilities, or one whose init cannot be found at all, which is exactly the
 * failure mode nobody can reproduce locally. So it is asserted here.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  APPLE_CONTAINER_INIT_ENTRYPOINT,
  APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION,
  APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE,
  APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION,
  APPLE_CONTAINER_VMINITD_PATH,
} from './transport-capabilities';

const repoRoot = path.resolve(__dirname, '..', '..');
const dockerfile = fs.readFileSync(
  path.join(repoRoot, 'containers', 'apple-init', 'Dockerfile'),
  'utf8',
);
const buildScript = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'build-apple-init-image.sh'),
  'utf8',
);

function argDefault(name: string): string | undefined {
  const match = new RegExp(`^ARG ${name}=(.+)$`, 'm').exec(dockerfile);
  return match?.[1].trim();
}

describe('Apple init image Dockerfile', () => {
  it('relocates Apple\'s init to the path the shim execs', () => {
    expect(dockerfile).toContain(`mv /rootfs${APPLE_CONTAINER_INIT_ENTRYPOINT} /rootfs${APPLE_CONTAINER_VMINITD_PATH}`);
  });

  it('installs the shim where Apple\'s runtime executes init from', () => {
    expect(dockerfile).toContain(`install -m 0755 /shim/vminitd /rootfs${APPLE_CONTAINER_INIT_ENTRYPOINT}`);
    expect(dockerfile).toContain(`ENTRYPOINT ["${APPLE_CONTAINER_INIT_ENTRYPOINT}"]`);
  });

  it('records the same CLI range the host half enforces', () => {
    expect(argDefault('AWF_CLI_MIN_VERSION')).toBe(APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION);
    expect(argDefault('AWF_CLI_MAX_VERSION_EXCLUSIVE'))
      .toBe(APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE);
    expect(argDefault('AWF_TRANSPORT_CONTRACT_VERSION'))
      .toBe(String(APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION));
  });

  it('exposes the coupling as labels so a built image can be checked without unpacking it', () => {
    for (const label of [
      'io.github.gh-aw-firewall.apple-init.base',
      'io.github.gh-aw-firewall.apple-init.contract-version',
      'io.github.gh-aw-firewall.apple-init.cli-min-version',
      'io.github.gh-aw-firewall.apple-init.cli-max-version-exclusive',
    ]) {
      expect(dockerfile).toContain(`LABEL ${label}=`);
    }
  });

  it('has no default for the Apple base image, so a build cannot silently float', () => {
    expect(dockerfile).toMatch(/^ARG AWF_VMINIT_IMAGE$/m);
    expect(argDefault('AWF_VMINIT_IMAGE')).toBeUndefined();
  });

  it('refuses a base image that is not digest-pinned', () => {
    expect(dockerfile).toContain('AWF_VMINIT_IMAGE must be digest-pinned');
    expect(dockerfile).toContain('*@sha256:*)');
  });

  it('refuses to relocate twice, which would lose Apple\'s init entirely', () => {
    expect(dockerfile).toContain(`test ! -e /rootfs${APPLE_CONTAINER_VMINITD_PATH}`);
  });

  it('builds the shim as a static native arm64 Linux binary', () => {
    expect(dockerfile).toContain('CGO_ENABLED=0 GOOS=linux GOARCH=arm64');
    expect(dockerfile).toContain('-trimpath -buildvcs=false');
    expect(dockerfile).not.toContain('GOARCH=amd64');
  });

  it('pins every base image it builds from by digest', () => {
    const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
    for (const base of bases) {
      const isStageReference = ['scratch', 'toolchain', '${AWF_VMINIT_IMAGE}'].includes(base);
      if (isStageReference) continue;
      expect(base).toMatch(/@sha256:[a-f0-9]{64}$/);
    }
  });
});

describe('build-apple-init-image.sh', () => {
  it('refuses a non-arm64 platform', () => {
    expect(buildScript).toContain('refusing PLATFORM=');
  });

  it('refuses a base image that is not digest-pinned before invoking Docker', () => {
    expect(buildScript).toContain('AWF_VMINIT_IMAGE must be digest-pinned');
  });

  it('sources the CLI range from the host contract rather than duplicating it', () => {
    expect(buildScript).toContain('src/apple-container/transport-capabilities.ts');
    expect(buildScript).toContain('APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION');
    expect(buildScript).toContain('APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE');
  });
});
