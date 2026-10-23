import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '../..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf-8'));
}

function expectExactLockEntry(
  manifest: Record<string, unknown>,
  lock: Record<string, unknown>,
  dependencyName: string,
  dependencySection: string,
): void {
  const version = (manifest[dependencySection] as Record<string, unknown>)[dependencyName];
  expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  const lockEntry = (lock.packages as Record<string, Record<string, unknown>>)[
    `node_modules/${dependencyName}`
  ];
  expect(lockEntry.version).toBe(version);
  expect(lockEntry.integrity).toMatch(/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/);
}

describe('reproducible npm CLI installs', () => {
  it.each(['api-proxy', 'cli-proxy'])(
    'uses registry tarballs compatible with npm remote-fetch restrictions in %s',
    (sidecar) => {
      const lock = readJson(`containers/${sidecar}/package-lock.json`);
      const packages = lock.packages as Record<string, { resolved?: string }>;
      for (const [packagePath, entry] of Object.entries(packages)) {
        if (packagePath === '') continue;
        expect({ packagePath, resolved: entry.resolved }).toEqual({
          packagePath,
          resolved: expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//),
        });
      }
    },
  );

  it('uses a lockfile-pinned local pkg executable for release binaries', () => {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/release.yml'),
      'utf-8',
    );

    expectExactLockEntry(packageJson, packageLock, '@yao-pkg/pkg', 'devDependencies');
    expect((packageJson.pkg as { targets: string[] }).targets).toEqual([
      'node24-linux-x64',
      'node24-linux-arm64',
      'node24-macos-x64',
      'node24-macos-arm64',
    ]);
    expect(workflow).toContain('./node_modules/.bin/pkg .');
    expect(workflow).not.toContain('npm install -g pkg');
  });

  it('locks Copilot CLI dependencies used by the enclave image and routing test', () => {
    const enclavePackage = readJson('containers/enclave/package.json');
    const enclaveLock = readJson('containers/enclave/package-lock.json');
    const routingPackage = readJson('scripts/ci/copilot-cli/package.json');
    const routingLock = readJson('scripts/ci/copilot-cli/package-lock.json');
    const enclaveDockerfile = fs.readFileSync(
      path.join(repositoryRoot, 'containers/enclave/Dockerfile'),
      'utf-8',
    );
    const routingWorkflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/test-model-routing.yml'),
      'utf-8',
    );

    expectExactLockEntry(enclavePackage, enclaveLock, '@github/copilot', 'dependencies');
    expectExactLockEntry(enclavePackage, enclaveLock, 'adm-zip', 'dependencies');
    expect(enclaveDockerfile).toContain('npm ci --prefix /tmp/copilot-cli --install-strategy=nested');
    expect(enclaveDockerfile).toContain(
      'cp -a /tmp/copilot-cli/node_modules/. /usr/local/lib/node_modules/@github/copilot/node_modules/',
    );
    expect(enclaveDockerfile).not.toContain('npm install -g');

    expectExactLockEntry(routingPackage, routingLock, '@github/copilot', 'dependencies');
    expect(routingWorkflow).toContain(
      'npm ci --prefix "${GITHUB_WORKSPACE}/scripts/ci/copilot-cli"',
    );
    expect(routingWorkflow).not.toContain('npm install --global');
  });
});
