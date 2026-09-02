import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWorkspaceMounts, buildCustomVolumeMounts } from './workspace-mounts';
import { makeAgentVolumeConfig } from './agent-volumes.test-utils';
import { WrapperConfig } from '../../types';
import * as dockerHostStaging from './docker-host-staging';
import { logger } from '../../logger';

// `statSync` is wrapped so tests can simulate a host working directory that
// lives outside every default mount without creating it on disk.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: jest.fn((...args: Parameters<typeof actual.statSync>) => actual.statSync(...args)),
  };
});

jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeParams(config: WrapperConfig, projectRoot: string, workspaceDir = '/workspace') {
  return {
    config,
    projectRoot,
    effectiveHome: '/home/runner',
    workspaceDir,
    agentLogsPath: '/tmp/awf-logs',
    sessionStatePath: '/tmp/awf-session',
    initSignalDir: '/tmp/awf-init',
  };
}

describe('buildWorkspaceMounts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ws-mounts-'));
    jest.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('standard mounts', () => {
    it('always includes /tmp, workspace, logs, session-state, init-signal mounts', () => {
      const config = makeAgentVolumeConfig();
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

      expect(mounts).toContain('/tmp:/tmp:rw');
      expect(mounts).toContain('/workspace:/workspace:rw');
      expect(mounts).toContain('/tmp/awf-logs:/home/runner/.copilot/logs:rw');
      expect(mounts).toContain('/tmp/awf-session:/home/runner/.copilot/session-state:rw');
      expect(mounts).toContain('/tmp/awf-init:/run/awf-init:rw');
    });
  });

  describe('enableApiProxy', () => {
    it('adds api-proxy-health-check.sh mount when file exists', () => {
      const healthCheckPath = path.join(tmpDir, 'containers', 'agent');
      fs.mkdirSync(healthCheckPath, { recursive: true });
      fs.writeFileSync(path.join(healthCheckPath, 'api-proxy-health-check.sh'), '#!/bin/sh\n');

      const config = makeAgentVolumeConfig({ enableApiProxy: true });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      const mount = mounts.find(m => m.includes('api-proxy-health-check.sh'));
      expect(mount).toBeDefined();
      expect(mount).toContain(':/usr/local/bin/api-proxy-health-check.sh:ro');
    });

    it('skips api-proxy-health-check.sh mount when file does not exist', () => {
      const config = makeAgentVolumeConfig({ enableApiProxy: true });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      expect(mounts.some(m => m.includes('api-proxy-health-check.sh'))).toBe(false);
    });

    it('skips api-proxy-health-check.sh mount when enableApiProxy is false', () => {
      const healthCheckPath = path.join(tmpDir, 'containers', 'agent');
      fs.mkdirSync(healthCheckPath, { recursive: true });
      fs.writeFileSync(path.join(healthCheckPath, 'api-proxy-health-check.sh'), '#!/bin/sh\n');

      const config = makeAgentVolumeConfig({ enableApiProxy: false });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      expect(mounts.some(m => m.includes('api-proxy-health-check.sh'))).toBe(false);
    });
  });

  describe('DinD binary staging (shouldUseDockerHostStaging=true)', () => {
    beforeEach(() => {
      jest.spyOn(dockerHostStaging, 'shouldUseDockerHostStaging').mockReturnValue(true);
    });

    it('stages binary and adds mount when binary is found at absolute path', () => {
      const binaryPath = path.join(tmpDir, 'myagent');
      fs.writeFileSync(binaryPath, '#!/bin/sh\n');
      fs.chmodSync(binaryPath, 0o755);

      const stagedPath = path.join(tmpDir, 'staged-myagent');
      fs.writeFileSync(stagedPath, '#!/bin/sh\n');
      jest.spyOn(dockerHostStaging, 'extractCommandBinaryName').mockReturnValue('myagent');
      jest.spyOn(dockerHostStaging, 'stageHostFile').mockReturnValue(stagedPath);

      // Use absolute path so resolveBinaryPath finds it without PATH lookup
      const config = makeAgentVolumeConfig({ agentCommand: `${binaryPath} --flag`, dockerHostPathPrefix: '/tmp' });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      const binaryMount = mounts.find(m => m.includes('/tmp/awf-runner-bin/myagent'));
      expect(binaryMount).toBeDefined();
      expect(binaryMount).toContain(':ro');
    });

    it('skips binary mount when stageHostFile returns undefined', () => {
      jest.spyOn(dockerHostStaging, 'extractCommandBinaryName').mockReturnValue('myagent');
      jest.spyOn(dockerHostStaging, 'stageHostFile').mockReturnValue(undefined);

      const config = makeAgentVolumeConfig({ agentCommand: 'myagent', dockerHostPathPrefix: '/tmp' });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      expect(mounts.some(m => m.includes('awf-runner-bin'))).toBe(false);
    });

    it('skips binary mount when extractCommandBinaryName returns undefined', () => {
      jest.spyOn(dockerHostStaging, 'extractCommandBinaryName').mockReturnValue(undefined);

      const config = makeAgentVolumeConfig({ agentCommand: '', dockerHostPathPrefix: '/tmp' });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      expect(mounts.some(m => m.includes('awf-runner-bin'))).toBe(false);
    });

    it('skips binary mount when binary is not found on PATH (line 75)', () => {
      jest.spyOn(dockerHostStaging, 'extractCommandBinaryName').mockReturnValue('nonexistent-binary-xyz');
      // stageHostFile should not be called since binarySourcePath will be undefined
      const stageHostFileSpy = jest.spyOn(dockerHostStaging, 'stageHostFile');

      const origPath = process.env.PATH;
      process.env.PATH = '/tmp/empty-dir-that-does-not-exist';
      try {
        const config = makeAgentVolumeConfig({ agentCommand: 'nonexistent-binary-xyz', dockerHostPathPrefix: '/tmp' });
        const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

        expect(mounts.some(m => m.includes('awf-runner-bin'))).toBe(false);
        expect(stageHostFileSpy).not.toHaveBeenCalled();
      } finally {
        if (origPath !== undefined) {
          process.env.PATH = origPath;
        } else {
          delete process.env.PATH;
        }
      }
    });
  });

  describe('no DinD staging when shouldUseDockerHostStaging=false', () => {
    it('does not add binary mount in non-DinD mode', () => {
      const config = makeAgentVolumeConfig({ agentCommand: 'echo test', dockerHostPathPrefix: undefined });
      const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

      expect(mounts.some(m => m.includes('awf-runner-bin'))).toBe(false);
    });
  });
});

describe('buildCustomVolumeMounts', () => {
  it('returns empty array when volumeMounts is undefined', () => {
    expect(buildCustomVolumeMounts(undefined)).toEqual([]);
  });

  it('returns empty array when volumeMounts is empty', () => {
    expect(buildCustomVolumeMounts([])).toEqual([]);
  });

  it('adds /host prefix to container path for two-part mounts', () => {
    const result = buildCustomVolumeMounts(['/data:/mydata']);
    expect(result).toEqual(['/data:/host/mydata']);
  });

  it('preserves mode in three-part mounts and adds /host prefix', () => {
    const result = buildCustomVolumeMounts(['/data:/mydata:ro']);
    expect(result).toEqual(['/data:/host/mydata:ro']);
  });

  it('preserves mounts with no colon separator as-is', () => {
    const result = buildCustomVolumeMounts(['named-volume']);
    expect(result).toEqual(['named-volume']);
  });

  it('transforms multiple mounts independently', () => {
    const result = buildCustomVolumeMounts(['/a:/b', '/c:/d:ro', 'named']);
    expect(result).toEqual(['/a:/host/b', '/c:/host/d:ro', 'named']);
  });

  it('does not double-prefix targets that already start with /host', () => {
    const result = buildCustomVolumeMounts(['/data:/host/data:ro', '/root:/host']);
    expect(result).toEqual(['/data:/host/data:ro', '/root:/host']);
  });
});

describe('container working directory visibility', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-workdir-'));
    jest.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const actual = jest.requireActual<typeof import('fs')>('fs');
    (fs.statSync as unknown as jest.Mock).mockImplementation(
      (...args: Parameters<typeof actual.statSync>) => actual.statSync(...args),
    );
  });

  it('does not add a mount when the working directory is the workspace', () => {
    const config = makeAgentVolumeConfig({ containerWorkDir: '/workspace/repo' });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

    expect(mounts.filter(m => m.includes('/workspace/repo'))).toEqual([]);
  });

  it('does not add a mount when the working directory is covered by /tmp or a system mount', () => {
    const tmpConfig = makeAgentVolumeConfig({ containerWorkDir: '/tmp/build' });
    expect(buildWorkspaceMounts(makeParams(tmpConfig, tmpDir)).some(m => m.startsWith('/tmp/build:'))).toBe(false);

    const usrConfig = makeAgentVolumeConfig({ containerWorkDir: '/usr/local/src' });
    expect(buildWorkspaceMounts(makeParams(usrConfig, tmpDir)).some(m => m.startsWith('/usr/local/src:'))).toBe(false);
  });

  it('does not add a mount for the chroot home itself', () => {
    const config = makeAgentVolumeConfig({ containerWorkDir: '/home/runner' });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir));

    expect(mounts.some(m => m.startsWith('/home/runner:'))).toBe(false);
  });

  // The working directory lives outside every default mount (/tmp, /usr, …),
  // so its presence on the host is simulated rather than created on disk.
  const externalWorkDir = '/srv/checkout';

  function pretendWorkDirExists(existingPath: string = externalWorkDir): void {
    const actual = jest.requireActual<typeof import('fs')>('fs');
    (fs.statSync as unknown as jest.Mock).mockImplementation((target: unknown, ...rest: unknown[]) => {
      if (String(target) === existingPath) {
        return { isDirectory: () => true, isFile: () => false } as fs.Stats;
      }
      return (actual.statSync as (...args: unknown[]) => fs.Stats)(target, ...rest);
    });
  }

  it('mounts a working directory that no other mount exposes', () => {
    pretendWorkDirExists();

    const config = makeAgentVolumeConfig({ containerWorkDir: externalWorkDir });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

    expect(mounts).toContain(`${externalWorkDir}:${externalWorkDir}:rw`);
    expect(mounts).toContain(`${externalWorkDir}:/host${externalWorkDir}:rw`);
  });

  it('skips a working directory already exposed by a custom volume mount', () => {
    pretendWorkDirExists();

    const config = makeAgentVolumeConfig({
      containerWorkDir: externalWorkDir,
      volumeMounts: [`${externalWorkDir}:${externalWorkDir}:rw`],
    });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

    expect(mounts.some(m => m.startsWith(`${externalWorkDir}:`))).toBe(false);
  });

  it('warns instead of mounting when the working directory does not exist on the host', () => {
    const missing = '/srv/missing-checkout';
    const config = makeAgentVolumeConfig({ containerWorkDir: missing });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

    expect(mounts.some(m => m.startsWith(`${missing}:`))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not exist on the host'));
  });

  it('refuses to mount a working directory inside a hidden credential path', () => {
    pretendWorkDirExists('/home/runner/.ssh/work');

    const config = makeAgentVolumeConfig({ containerWorkDir: '/home/runner/.ssh/work' });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

    expect(mounts.some(m => m.startsWith('/home/runner/.ssh'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deliberately hides'));
  });

  it('refuses to mount a working directory inside a hidden host system path', () => {
    pretendWorkDirExists('/etc/agent-workspace');

    const config = makeAgentVolumeConfig({ containerWorkDir: '/etc/agent-workspace' });
    const mounts = buildWorkspaceMounts(makeParams(config, tmpDir, '/workspace'));

    expect(mounts.some(m => m.startsWith('/etc/agent-workspace'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('deliberately hides'));
  });
});
