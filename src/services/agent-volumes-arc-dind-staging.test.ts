import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import { stageHostFile } from './agent-volumes/docker-host-staging';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
import { mockExecaSync } from '../test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it('should auto-stage the ARC/DinD manual bootstrap files under a shared /tmp docker-host-path-prefix', () => {
    const originalPath = process.env.PATH;
    const sharedTmpPrefix = fs.mkdtempSync(path.join('/tmp', 'gh-aw-'));
    const fakeBinDir = path.join(getConfig().workDir, 'fake-bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeCopilotPath = path.join(fakeBinDir, 'copilot');
    fs.writeFileSync(fakeCopilotPath, '#!/bin/sh\necho copilot\n', { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;
    mockExecaSync.mockImplementation((command: string, args?: string[]) => {
      if (command === 'docker' && args?.[0] === 'network' && args[1] === 'inspect') {
        return { stdout: '172.17.0.1', stderr: '', exitCode: 0 };
      }
      throw new Error('Not found');
    });

    try {
      const configWithTmpPrefix = {
        ...getConfig(),
        dockerHostPathPrefix: sharedTmpPrefix,
        agentCommand: 'copilot --version',
        enableHostAccess: true,
      };
      const result = generateDockerCompose(configWithTmpPrefix, mockNetworkConfig);
      const volumes = result.services.agent.volumes as string[];
      const stageRoot = path.join(sharedTmpPrefix, 'awf-docker-host-stage');
      const stagedBinaryPath = path.join(stageRoot, 'bin/copilot');
      const hostsVolume = volumes.find((v: string) => v.endsWith(':/host/etc/hosts:ro'));
      const passwdVolume = volumes.find((v: string) => v.endsWith(':/host/etc/passwd:ro'));
      const groupVolume = volumes.find((v: string) => v.endsWith(':/host/etc/group:ro'));

      // passwd and group are staged under stageRoot — either at etc/passwd (direct copy)
      // or identity-XXXXX/passwd (synthesized when host UID not found in staged file)
      expect(passwdVolume).toBeDefined();
      expect(passwdVolume?.startsWith(stageRoot)).toBe(true);
      expect(groupVolume).toBeDefined();
      expect(groupVolume?.startsWith(stageRoot)).toBe(true);
      expect(volumes).toContain(`${stagedBinaryPath}:/tmp/awf-runner-bin/copilot:ro`);
      expect(hostsVolume).toBeDefined();
      expect(hostsVolume?.startsWith(`${stageRoot}/chroot-`)).toBe(true);

      const stagedPasswdPath = passwdVolume!.split(':')[0];
      const stagedGroupPath = groupVolume!.split(':')[0];
      // Staged passwd must contain the host UID (either copied or synthesized)
      const { getSafeHostUid } = jest.requireActual('../host-identity') as typeof import('../host-identity');
      const uid = getSafeHostUid();
      expect(fs.readFileSync(stagedPasswdPath, 'utf8')).toMatch(new RegExp(`^[^:]*:[^:]*:${uid}:`, 'm'));
      expect(fs.existsSync(stagedGroupPath)).toBe(true);
      expect(fs.readFileSync(stagedBinaryPath, 'utf8')).toContain('echo copilot');
      expect(fs.statSync(stagedBinaryPath).mode & 0o111).not.toBe(0);

      const stagedHostsPath = hostsVolume?.split(':', 1)[0];
      expect(stagedHostsPath).toBeDefined();
      expect(fs.existsSync(stagedHostsPath || '')).toBe(true);
      expect(fs.readFileSync(stagedHostsPath || '', 'utf8')).toContain('172.17.0.1\thost.docker.internal');

      expect(volumes.some((v: string) => v.includes(`${sharedTmpPrefix}/arc-etc/`))).toBe(false);
      expect(volumes.some((v: string) => v.includes(`${sharedTmpPrefix}/arc-tools/`))).toBe(false);
    } finally {
      mockExecaSync.mockReset();
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
      fs.rmSync(sharedTmpPrefix, { recursive: true, force: true });
    }
  });

  it('should skip non-executable PATH candidates when staging the runner binary', () => {
    const originalPath = process.env.PATH;
    const stagePrefix = fs.mkdtempSync(path.join('/tmp', 'gh-aw-'));
    const nonExecutableDir = path.join(getConfig().workDir, 'fake-bin-nonexec');
    const executableDir = path.join(getConfig().workDir, 'fake-bin-exec');
    fs.mkdirSync(nonExecutableDir, { recursive: true });
    fs.mkdirSync(executableDir, { recursive: true });
    fs.writeFileSync(path.join(nonExecutableDir, 'copilot'), '#!/bin/sh\necho wrong\n', { mode: 0o644 });
    fs.writeFileSync(path.join(executableDir, 'copilot'), '#!/bin/sh\necho correct\n', { mode: 0o755 });
    process.env.PATH = `${nonExecutableDir}${path.delimiter}${executableDir}${path.delimiter}${originalPath || ''}`;

    try {
      generateDockerCompose(
        {
          ...getConfig(),
          dockerHostPathPrefix: stagePrefix,
          agentCommand: 'copilot --version',
        },
        mockNetworkConfig,
      );

      const stagedBinaryPath = path.join(stagePrefix, 'awf-docker-host-stage/bin/copilot');
      expect(fs.readFileSync(stagedBinaryPath, 'utf8')).toContain('correct');
    } finally {
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
      fs.rmSync(stagePrefix, { recursive: true, force: true });
    }
  });

  it('should prefer an explicit command path when staging the runner binary', () => {
    const originalPath = process.env.PATH;
    const stagePrefix = fs.mkdtempSync(path.join('/tmp', 'gh-aw-'));
    const fakeBinDir = path.join(getConfig().workDir, 'fake-bin-path');
    const explicitBinDir = path.join(getConfig().workDir, 'explicit-bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(explicitBinDir, { recursive: true });
    fs.writeFileSync(path.join(fakeBinDir, 'copilot'), '#!/bin/sh\necho path\n', { mode: 0o755 });
    const explicitBinaryPath = path.join(explicitBinDir, 'copilot');
    fs.writeFileSync(explicitBinaryPath, '#!/bin/sh\necho explicit\n', { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ''}`;

    try {
      generateDockerCompose(
        {
          ...getConfig(),
          dockerHostPathPrefix: stagePrefix,
          agentCommand: `${explicitBinaryPath} --version`,
        },
        mockNetworkConfig,
      );

      const stagedBinaryPath = path.join(stagePrefix, 'awf-docker-host-stage/bin/copilot');
      expect(fs.readFileSync(stagedBinaryPath, 'utf8')).toContain('explicit');
    } finally {
      if (originalPath !== undefined) {
        process.env.PATH = originalPath;
      } else {
        delete process.env.PATH;
      }
      fs.rmSync(stagePrefix, { recursive: true, force: true });
    }
  });

  it('should leave /etc/passwd and /etc/group unprefixed in shared /tmp staging fallback mode', () => {
    expect(applyHostPathPrefixToVolumes(['/etc/passwd:/host/etc/passwd:ro'], '/tmp/gh-aw'))
      .toEqual(['/etc/passwd:/host/etc/passwd:ro']);
    expect(applyHostPathPrefixToVolumes(['/etc/group:/host/etc/group:ro'], '/tmp/gh-aw'))
      .toEqual(['/etc/group:/host/etc/group:ro']);
  });

  it('should prune stale staged chroot hosts directories under shared /tmp docker-host-path-prefix', () => {
    const stagePrefix = fs.mkdtempSync(path.join('/tmp', 'gh-aw-'));
    try {
      const stageRoot = path.join(stagePrefix, 'awf-docker-host-stage');
      const staleDir = path.join(stageRoot, 'chroot-stale');
      fs.mkdirSync(staleDir, { recursive: true });
      fs.writeFileSync(path.join(staleDir, 'hosts'), '127.0.0.1 localhost\n');
      const staleTime = new Date(Date.now() - (25 * 60 * 60 * 1000));
      fs.utimesSync(staleDir, staleTime, staleTime);
      fs.utimesSync(path.join(staleDir, 'hosts'), staleTime, staleTime);

      const result = generateDockerCompose(
        {
          ...getConfig(),
          dockerHostPathPrefix: stagePrefix,
        },
        mockNetworkConfig,
      );
      const volumes = result.services.agent.volumes as string[];

      expect(fs.existsSync(staleDir)).toBe(false);
      expect(
        volumes.some((v: string) => v.startsWith(`${stageRoot}/chroot-`) && v.endsWith(':/host/etc/hosts:ro'))
      ).toBe(true);
    } finally {
      fs.rmSync(stagePrefix, { recursive: true, force: true });
    }
  });

  it('should reject staged target paths that escape the docker-host staging root', () => {
    const stagePrefix = fs.mkdtempSync(path.join('/tmp', 'gh-aw-'));
    const sourceFile = path.join(getConfig().workDir, 'stage-source.txt');
    fs.writeFileSync(sourceFile, 'stage me');

    try {
      const stagedPath = stageHostFile(
        { ...getConfig(), dockerHostPathPrefix: stagePrefix },
        sourceFile,
        '../escaped.txt',
      );

      expect(stagedPath).toBeUndefined();
      expect(fs.existsSync(path.join(stagePrefix, 'escaped.txt'))).toBe(false);
    } finally {
      fs.rmSync(stagePrefix, { recursive: true, force: true });
    }
  });
});
