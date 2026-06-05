import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDindBootstrap } from './dind-bootstrap';
import type { WrapperConfig } from './types';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'echo ok',
    logLevel: 'info',
    keepContainers: false,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    workDir: '/tmp/awf-test',
    ...overrides,
  };
}

describe('runDindBootstrap', () => {
  const originalDockerHost = process.env.DOCKER_HOST;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DOCKER_HOST = 'tcp://localhost:2375';
    mockExecaFn.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  afterEach(() => {
    if (originalDockerHost !== undefined) {
      process.env.DOCKER_HOST = originalDockerHost;
    } else {
      delete process.env.DOCKER_HOST;
    }
  });

  it('pre-stages DinD directories when enabled', async () => {
    await runDindBootstrap(makeConfig({
      dind: {
        preStageDirs: true,
        workDir: '/tmp/gh-aw',
        stagingImage: 'busybox:latest',
      },
    }));

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '--rm', '-v', '/tmp/gh-aw:/awf-work:rw', 'busybox:latest']),
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it('stages engine binary when configured', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dind-bootstrap-'));
    const sourcePath = path.join(tempDir, 'copilot');
    fs.writeFileSync(sourcePath, 'binary-data');
    fs.chmodSync(sourcePath, 0o755);

    try {
      await runDindBootstrap(makeConfig({
        dind: {
          stageEngineBinary: {
            path: sourcePath,
            targetPath: '/usr/local/bin/copilot',
          },
          stagingImage: 'busybox:latest',
        },
      }));

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '--rm', '-i', '-v', '/usr/local/bin:/awf-target:rw', 'busybox:latest']),
        expect.objectContaining({ input: expect.any(Buffer) }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips when DinD signals are absent', async () => {
    delete process.env.DOCKER_HOST;
    await runDindBootstrap(makeConfig({
      dind: { preStageDirs: true },
      enableDind: false,
      dockerHostPathPrefix: undefined,
    }));

    expect(mockExecaFn).not.toHaveBeenCalled();
  });
});
