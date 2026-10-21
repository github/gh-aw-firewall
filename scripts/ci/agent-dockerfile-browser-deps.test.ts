import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const dockerfilePath = path.resolve(__dirname, '../../containers/agent/Dockerfile');

const readDockerfile = (): string => fs.readFileSync(dockerfilePath, 'utf-8');

const readBrowserPackages = (): string[] => {
  const declaration = readDockerfile().match(/BROWSER_PKGS="([^"]+)"/)?.[1];
  expect(declaration).toBeDefined();
  return declaration!.split(/\s+/).filter(Boolean);
};

/**
 * Extracts the shell loop that appends the browser packages to PKGS, resolving
 * Ubuntu 24.04 `t64` package renames, so it can be exercised with a stubbed
 * `apt-cache`.
 */
const readResolutionScript = (): string => {
  const block = readDockerfile().match(/for pkg in \$BROWSER_PKGS; do[\s\S]*?done && \\/)?.[0];

  expect(block).toBeDefined();
  return block!
    .replace(/done && \\\s*$/, 'done')
    .split('\n')
    .map((line) => line.trim().replace(/\s*\\$/, ''))
    .join('\n');
};

const runResolution = (t64Packages: string[]): string => {
  const script = `
set -eu
apt-cache() {
  for available in ${t64Packages.map((pkg) => `"${pkg}"`).join(' ')}; do
    if [ "$2" = "$available" ]; then return 0; fi
  done
  return 100
}
BROWSER_ACTUAL_PKGS=""
BROWSER_PKGS="${readBrowserPackages().join(' ')}"
${readResolutionScript()}
echo "$BROWSER_ACTUAL_PKGS"
`;

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  expect(result.status).toBe(0);
  return result.stdout.trim();
};

describe('agent Dockerfile Chromium runtime dependencies', () => {
  it('preinstalls the shared libraries Playwright-managed Chromium needs', () => {
    const packages = readBrowserPackages();

    for (const required of [
      'libasound2',
      'libatk-bridge2.0-0',
      'libatk1.0-0',
      'libatspi2.0-0',
      'libcups2',
      'libdbus-1-3',
      'libdrm2',
      'libgbm1',
      'libglib2.0-0',
      'libnspr4',
      'libnss3',
      'libpango-1.0-0',
      'libxcomposite1',
      'libxdamage1',
      'libxfixes3',
      'libxkbcommon0',
      'libxrandr2',
      'fonts-liberation',
    ]) {
      expect(packages).toContain(required);
    }
  });

  it('declares the base (22.04) package names, never the t64 variants', () => {
    for (const pkg of readBrowserPackages()) {
      expect(pkg.endsWith('t64')).toBe(false);
    }
  });

  it('keeps the 22.04 names when the base image has no t64 packages', () => {
    const resolved = runResolution([]);

    expect(resolved.split(/\s+/).filter(Boolean)).toEqual(readBrowserPackages());
  });

  it('prefers t64 packages when the base image provides them', () => {
    const resolved = runResolution(['libasound2t64', 'libcups2t64']);

    expect(resolved).toContain('libasound2t64');
    expect(resolved).toContain('libcups2t64');
    expect(resolved.split(/\s+/)).not.toContain('libasound2');
    expect(resolved.split(/\s+/)).not.toContain('libcups2');
    expect(resolved).toContain('libnss3');
  });

  it('preserves native browser packages for non-chroot execution', () => {
    expect(readDockerfile()).toMatch(/apt_install_retry \$PKGS/);
    expect(readDockerfile()).toMatch(/apt_install_retry \$BROWSER_ACTUAL_PKGS/);
    expect(readDockerfile()).toContain('BROWSER_PKGS="$(cat /usr/local/share/awf/browser-packages.txt)"');
  });

  it('builds the chroot payload on the oldest supported runner independently of BASE_IMAGE', () => {
    const dockerfile = readDockerfile();
    expect(dockerfile).toMatch(/FROM ubuntu:22\.04@sha256:[a-f0-9]+ AS browser-libs/);
    expect(dockerfile).toContain('COPY --from=browser-libs /usr/local/share/awf/ /usr/local/share/awf/');
    expect(dockerfile).toContain("grep -Ev '^(libc6|libgcc-s1|libstdc\\+\\+6)$'");
    expect(dockerfile).toContain('cp -L "$lib" "/usr/local/share/awf/browser-libs$lib"');
  });

  it('records the installed .so files into a manifest entrypoint.sh stages for the chroot', () => {
    const dockerfile = readDockerfile();
    expect(dockerfile).toMatch(/\/usr\/local\/share\/awf\/browser-libs\.manifest/);
    expect(dockerfile).toMatch(/dpkg -L \$\(cat \/tmp\/browser-pkgs-installed\.txt\)/);
  });

  it('includes transitive dependencies even when they were already installed in the base image', () => {
    expect(readDockerfile()).toContain('apt-cache depends --recurse --installed --no-recommends --no-suggests');
    expect(readDockerfile()).not.toContain('comm -13');
  });
});
