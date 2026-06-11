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
    const preStageCommand = mockExecaFn.mock.calls[0]?.[1]?.[7];
    expect(preStageCommand).toContain('chmod 0777 /awf-work');
    expect(preStageCommand).not.toContain('chmod -R');
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

  it('returns early when dind config has neither preStageDirs nor stageEngineBinary', async () => {
    await runDindBootstrap(makeConfig({ dind: undefined }));
    expect(mockExecaFn).not.toHaveBeenCalled();
  });

  it('detects DinD via enableDind flag', async () => {
    delete process.env.DOCKER_HOST;
    await runDindBootstrap(makeConfig({
      enableDind: true,
      dind: {
        preStageDirs: true,
        workDir: '/tmp/gh-aw',
        stagingImage: 'busybox:latest',
      },
    }));

    expect(mockExecaFn).toHaveBeenCalled();
  });

  it('uses default staging image and workDir when not specified', async () => {
    await runDindBootstrap(makeConfig({
      dind: { preStageDirs: true },
    }));

    expect(mockExecaFn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['-v', '/tmp/gh-aw:/awf-work:rw', 'ghcr.io/github/gh-aw-firewall/agent:latest']),
      expect.any(Object),
    );
  });

  it('uses source path as targetPath when stageEngineBinary.targetPath is omitted', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dind-bootstrap-'));
    const sourcePath = path.join(tempDir, 'copilot');
    fs.writeFileSync(sourcePath, 'binary-data');

    try {
      await runDindBootstrap(makeConfig({
        dind: {
          stageEngineBinary: { path: sourcePath },
          stagingImage: 'busybox:latest',
        },
      }));

      const targetDir = path.posix.dirname(sourcePath);
      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-v', `${targetDir}:/awf-target:rw`]),
        expect.any(Object),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects DinD via unix socket path that is not a standard socket', async () => {
    process.env.DOCKER_HOST = 'unix:///run/custom/docker.sock';
    await runDindBootstrap(makeConfig({
      dind: {
        preStageDirs: true,
        workDir: '/tmp/gh-aw',
        stagingImage: 'busybox:latest',
      },
    }));

    expect(mockExecaFn).toHaveBeenCalled();
  });

  it('throws when preStageDirs workDir is a relative path', async () => {
    await expect(
      runDindBootstrap(makeConfig({
        dind: {
          preStageDirs: true,
          workDir: 'relative/path',
          stagingImage: 'busybox:latest',
        },
      })),
    ).rejects.toThrow('dind.workDir must be an absolute path');
  });

  it('throws when stageEngineBinary targetPath has an unsafe file name', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dind-bootstrap-'));
    const sourcePath = path.join(tempDir, 'copilot');
    fs.writeFileSync(sourcePath, 'binary-data');

    try {
      await expect(
        runDindBootstrap(makeConfig({
          dind: {
            stageEngineBinary: {
              path: sourcePath,
              targetPath: '/usr/local/bin/bad name!',
            },
            stagingImage: 'busybox:latest',
          },
        })),
      ).rejects.toThrow('dind.stageEngineBinary.targetPath has unsafe file name');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws when stageEngineBinary source path is a directory, not a file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dind-bootstrap-'));

    try {
      await expect(
        runDindBootstrap(makeConfig({
          dind: {
            stageEngineBinary: {
              path: tempDir,
              targetPath: '/usr/local/bin/copilot',
            },
            stagingImage: 'busybox:latest',
          },
        })),
      ).rejects.toThrow('dind.stageEngineBinary.path is not a file');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
