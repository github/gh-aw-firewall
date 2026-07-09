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

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => mockReaddirSync(...args),
    statSync: (...args: Parameters<typeof actual.statSync>) => mockStatSync(...args),
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
    tmpDir = actual.mkdtempSync(path.join(os.tmpdir(), 'awf-prune-'));
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue({ stdout: '', stderr: '' });
    // Default: delegate to real implementations
    mockReaddirSync.mockImplementation((...args: Parameters<typeof actual.readdirSync>) =>
      actual.readdirSync(...args)
    );
    mockStatSync.mockImplementation((...args: Parameters<typeof actual.statSync>) =>
      actual.statSync(...args)
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
