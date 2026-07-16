/**
 * Branch-coverage tests for agent-volumes/hosts-file.ts.
 *
 * Targets the previously uncovered paths:
 *   Lines 53-57: enableHostAccess=true + localhostDetected=true →
 *                replace 127.0.0.1 localhost with gateway IP
 *   Lines 91-95: pruneStaleChrootStageDirs readdirSync failure → swallowed
 *                (triggered via dockerHostPathPrefix / DockerHostStaging)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../../test-helpers/mock-execa.test-utils').execaMockFactory());

jest.mock('../../logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockReaddirSync = jest.fn();
const mockStatSync = jest.fn();
const mockWriteFileSync = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => mockReaddirSync(...args),
    statSync: (...args: Parameters<typeof actual.statSync>) => mockStatSync(...args),
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => mockWriteFileSync(...args),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateHostsFileMount } from './hosts-file';
import { WrapperConfig } from '../../types';
import { mockExecaSync } from '../../test-helpers/mock-execa.test-utils';

const actual = jest.requireActual<typeof import('fs')>('fs');

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '',            // set per-test to the temp dir
    allowedDomains: [],
    ...overrides,
  } as WrapperConfig;
}

describe('generateHostsFileMount – localhostDetected branch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = actual.mkdtempSync(path.join(os.tmpdir(), 'awf-hosts-'));
    jest.clearAllMocks();
    // Default: delegate to real implementations
    mockReaddirSync.mockImplementation((...args: Parameters<typeof actual.readdirSync>) =>
      actual.readdirSync(...args)
    );
    mockStatSync.mockImplementation((...args: Parameters<typeof actual.statSync>) =>
      actual.statSync(...args)
    );
    mockWriteFileSync.mockImplementation((...args: Parameters<typeof actual.writeFileSync>) =>
      actual.writeFileSync(...args)
    );
  });

  afterEach(() => {
    actual.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces 127.0.0.1 localhost with gateway IP when localhostDetected is true', () => {
    const gatewayIp = '172.17.0.1';

    // docker network inspect call
    mockExecaSync.mockReturnValue({ stdout: gatewayIp, stderr: '' });

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
      enableHostAccess: true,
      localhostDetected: true,
    });

    const mount = generateHostsFileMount(config);

    expect(mount).toMatch(/:\/host\/etc\/hosts:ro$/);
    const hostsPath = mount.split(':')[0];
    const content = fs.readFileSync(hostsPath, 'utf8');

    expect(content).toContain(`${gatewayIp}\thost.docker.internal`);
    expect(content).not.toMatch(/^127\.0\.0\.1\s+localhost/m);
    expect(content).toContain(`${gatewayIp}\tlocalhost`);
  });

  it('does not replace localhost when localhostDetected is false', () => {
    const gatewayIp = '172.17.0.1';
    mockExecaSync.mockReturnValue({ stdout: gatewayIp, stderr: '' });

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
      enableHostAccess: true,
      localhostDetected: false,
    });

    const mount = generateHostsFileMount(config);
    const hostsPath = mount.split(':')[0];
    const content = fs.readFileSync(hostsPath, 'utf8');

    expect(content).toContain(`${gatewayIp}\thost.docker.internal`);
    // localhost entry should not have been replaced with gateway IP
    expect(content).not.toContain(`${gatewayIp}\tlocalhost`);
  });
});

describe('pruneStaleChrootStageDirs – error handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Use /tmp/ prefix so shouldUseDockerHostStaging() returns true
    // (it requires paths starting with /tmp); os.tmpdir() on macOS
    // returns /var/folders/… which would skip the staging code path.
    tmpDir = actual.mkdtempSync(path.join('/tmp', 'awf-prune-'));
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue({ stdout: '', stderr: '' });
    // Default: delegate to real implementations
    mockReaddirSync.mockImplementation((...args: Parameters<typeof actual.readdirSync>) =>
      actual.readdirSync(...args)
    );
    mockStatSync.mockImplementation((...args: Parameters<typeof actual.statSync>) =>
      actual.statSync(...args)
    );
    mockWriteFileSync.mockImplementation((...args: Parameters<typeof actual.writeFileSync>) =>
      actual.writeFileSync(...args)
    );
  });

  afterEach(() => {
    actual.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('swallows readdirSync error when scanning chroot staging root fails', () => {
    // Trigger dockerHostPathPrefix path so pruneStaleChrootStageDirs is called
    mockReaddirSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
      dockerHostPathPrefix: tmpDir,  // non-empty → shouldUseDockerHostStaging returns true
    });

    expect(() => generateHostsFileMount(config)).not.toThrow();
  });

  it('swallows statSync error for individual chroot staging directory entries', () => {
    // Create a chroot- dir inside the docker-host staging root so pruneStaleChrootStageDirs iterates over it
    const stageRoot = path.join(tmpDir, 'awf-docker-host-stage');
    const staleDir = path.join(stageRoot, 'chroot-stale');
    actual.mkdirSync(staleDir, { recursive: true });

    mockStatSync.mockImplementationOnce(() => {
      throw new Error('ENOENT: no such file');
    });

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
      dockerHostPathPrefix: tmpDir,
    });

    expect(() => generateHostsFileMount(config)).not.toThrow();
    expect(mockStatSync).toHaveBeenCalled();
  });
});

describe('generateHostsFileMount – EACCES writeFileSync fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = actual.mkdtempSync(path.join(os.tmpdir(), 'awf-eacces-'));
    jest.clearAllMocks();
    mockReaddirSync.mockImplementation((...args: Parameters<typeof actual.readdirSync>) =>
      actual.readdirSync(...args)
    );
    mockStatSync.mockImplementation((...args: Parameters<typeof actual.statSync>) =>
      actual.statSync(...args)
    );
    mockWriteFileSync.mockImplementation((...args: Parameters<typeof actual.writeFileSync>) =>
      actual.writeFileSync(...args)
    );
  });

  afterEach(() => {
    actual.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to writing hosts file directly in hostsRootDir on EACCES', () => {
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    // First writeFileSync call (inside mkdtemp'd dir) throws EACCES;
    // second call (fallback to hostsRootDir) succeeds.
    mockWriteFileSync
      .mockImplementationOnce(() => { throw eaccesError; })
      .mockImplementation((...args: Parameters<typeof actual.writeFileSync>) =>
        actual.writeFileSync(...args)
      );

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
    });

    const mount = generateHostsFileMount(config);

    // Should return the fallback path (mkdtempSync in os.tmpdir)
    expect(mount).toMatch(/awf-chroot-[A-Za-z0-9]+\/hosts:\/host\/etc\/hosts:ro$/);
    const hostsPath = mount.split(':')[0];
    expect(actual.existsSync(hostsPath)).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
  });

  it('re-throws non-EACCES write errors', () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockWriteFileSync.mockImplementationOnce(() => { throw enoentError; });

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
    });

    expect(() => generateHostsFileMount(config)).toThrow('ENOENT');
  });

  it('re-throws EACCES errors in staging mode (shared hostsRootDir – no safe fallback)', () => {
    // Use a /tmp-prefixed path so shouldUseDockerHostStaging() returns true,
    // meaning hostsRootDir is a shared staging directory.
    const stagingTmpDir = actual.mkdtempSync(path.join('/tmp', 'awf-staging-eacces-'));
    try {
      const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      mockWriteFileSync.mockImplementationOnce(() => { throw eaccesError; });

      const config = makeConfig({
        workDir: stagingTmpDir,
        allowedDomains: [],
        dockerHostPathPrefix: stagingTmpDir,  // triggers useDockerHostStaging = true
      });

      // EACCES must propagate – no fallback when hostsRootDir is shared
      expect(() => generateHostsFileMount(config)).toThrow('EACCES');
      // The fallback writeFileSync must NOT have been called
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    } finally {
      actual.rmSync(stagingTmpDir, { recursive: true, force: true });
    }
  });

  it('emits diagnostic warning with uid/gid and stat info on EACCES fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('../../logger');
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    mockWriteFileSync
      .mockImplementationOnce(() => { throw eaccesError; })
      .mockImplementation((...args: Parameters<typeof actual.writeFileSync>) =>
        actual.writeFileSync(...args)
      );

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
    });

    generateHostsFileMount(config);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnMsg: string = logger.warn.mock.calls[0][0];
    expect(warnMsg).toContain('EACCES writing chroot hosts file');
    expect(warnMsg).toContain('Falling back');
    expect(warnMsg).toContain('chrootHostsDir:');
  });

  it('reports "(cannot stat)" when statSync fails during EACCES diagnostics', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('../../logger');
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });

    // writeFileSync: first call EACCES, second call (fallback) succeeds
    mockWriteFileSync
      .mockImplementationOnce(() => { throw eaccesError; })
      .mockImplementation((...args: Parameters<typeof actual.writeFileSync>) =>
        actual.writeFileSync(...args)
      );

    // statSync: always throw during diagnostics (covers the catch blocks)
    mockStatSync.mockImplementation(() => { throw new Error('stat failed'); });

    const config = makeConfig({
      workDir: tmpDir,
      allowedDomains: [],
    });

    const mount = generateHostsFileMount(config);
    expect(mount).toMatch(/awf-chroot-[A-Za-z0-9]+\/hosts:\/host\/etc\/hosts:ro$/);

    const warnMsg: string = logger.warn.mock.calls[0][0];
    expect(warnMsg).toContain('(cannot stat)');
  });
});
