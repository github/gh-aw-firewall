import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

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
  const packageRoots = [
    '.', 'docs-site', 'containers/api-proxy', 'containers/cli-proxy',
    'containers/enclave', 'scripts/ci/copilot-cli',
  ];

  it.each(packageRoots)(
    'uses only approved feed tarballs in %s',
    (packageRoot) => {
      const lock = readJson(`${packageRoot}/package-lock.json`);
      const packages = lock.packages as Record<string, { resolved?: string }>;
      for (const [packagePath, entry] of Object.entries(packages)) {
        if (packagePath === '') continue;
        expect({ packagePath, resolved: entry.resolved }).toEqual({
          packagePath,
          resolved: expect.stringMatching(/^https:\/\/packagefeedproxy\.microsoft\.io\/npm\//),
        });
      }
    },
  );

  it.each(packageRoots)('configures independent npm installs in %s', packageRoot => {
    const result = spawnSync('npm', [
      'config', 'get', 'registry', '--userconfig=/dev/null', '--globalconfig=/dev/null',
    ], {
      cwd: path.join(repositoryRoot, packageRoot),
      env: { ...process.env, NPM_CONFIG_REGISTRY: undefined, npm_config_registry: undefined },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('https://packagefeedproxy.microsoft.io/npm/');
  });

  it.each(['agent', 'api-proxy', 'cli-proxy', 'gh-aw-node', 'enclave'])(
    'configures container installs and direct npm downloads in %s', image => {
      const dockerfile = fs.readFileSync(
        path.join(repositoryRoot, `containers/${image}/Dockerfile`), 'utf8',
      );
      expect(dockerfile).toMatch(/(?:ENV|ARG) NPM_CONFIG_REGISTRY=https:\/\/packagefeedproxy\.microsoft\.io\/npm\//);
      expect(dockerfile).not.toContain('https://registry.npmjs.org/');
    },
  );

  it('configures global and scratch-directory npm installs in CI', () => {
    const workflows = path.join(repositoryRoot, '.github/workflows');
    for (const file of fs.readdirSync(workflows).filter(file => file.endsWith('.yml'))) {
      const source = fs.readFileSync(path.join(workflows, file), 'utf8');
      if (!/\bnpm\b|\bnpx\b/.test(source)) continue;
      const workflow = yaml.load(source) as { env?: { NPM_CONFIG_REGISTRY?: string } };
      expect({ file, registry: workflow.env?.NPM_CONFIG_REGISTRY }).toEqual({
        file, registry: 'https://packagefeedproxy.microsoft.io/npm/',
      });
      expect(source).not.toMatch(/npm (?:ci|install|outdated)[^\n]*--registry[= ]https:\/\/registry\.npmjs\.org/);
      for (const match of source.matchAll(/\\"allowDomains\\":\[([^\]]*)\]/g)) {
        if (match[1].includes('registry.npmjs.org')) {
          expect({ file, domains: match[1] }).toEqual({
            file, domains: expect.stringContaining('packagefeedproxy.microsoft.io'),
          });
        }
      }
    }
  });

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
