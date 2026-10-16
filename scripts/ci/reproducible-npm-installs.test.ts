import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '../..');

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf-8'));
}

describe('reproducible npm CLI installs', () => {
  it('uses a lockfile-pinned local pkg executable for release binaries', () => {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/release.yml'),
      'utf-8',
    );

    expect(packageJson.devDependencies['@yao-pkg/pkg']).toBe('6.23.0');
    expect(packageLock.packages['node_modules/@yao-pkg/pkg']).toMatchObject({
      version: '6.23.0',
      integrity: expect.any(String),
    });
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

    expect(enclavePackage.dependencies).toEqual({
      '@github/copilot': '1.0.77',
      'adm-zip': '0.6.1',
    });
    expect(enclaveLock.packages['node_modules/@github/copilot']).toMatchObject({
      version: '1.0.77',
      integrity: expect.any(String),
    });
    expect(enclaveLock.packages['node_modules/adm-zip']).toMatchObject({
      version: '0.6.1',
      integrity: expect.any(String),
    });
    expect(enclaveDockerfile).toContain('npm ci --prefix /tmp/copilot-cli --install-strategy=nested');
    expect(enclaveDockerfile).toContain(
      'cp -a /tmp/copilot-cli/node_modules/. /usr/local/lib/node_modules/@github/copilot/node_modules/',
    );
    expect(enclaveDockerfile).not.toContain('npm install -g');

    expect(routingPackage.dependencies['@github/copilot']).toBe('1.0.89');
    expect(routingLock.packages['node_modules/@github/copilot']).toMatchObject({
      version: '1.0.89',
      integrity: expect.any(String),
    });
    expect(routingWorkflow).toContain(
      'npm ci --prefix "${GITHUB_WORKSPACE}/scripts/ci/copilot-cli"',
    );
    expect(routingWorkflow).not.toContain('npm install --global');
  });
});
