import {
  DEVELOPMENT_ENCLAVE_SUPERVISOR_PATH,
  resolveDevelopmentEnclaveSupervisor,
} from './development-enclave-supervisor';
import { logger } from '../logger';

describe('public PR smoke development supervisor', () => {
  const sha256 = 'a'.repeat(64);
  const environment: NodeJS.ProcessEnv = {
    AWF_CH_ENCLAVE_TEST_SUPERVISOR_SHA256: sha256,
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'github/gh-aw-firewall',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REF: 'refs/heads/lpcox-smoke-pins-v0-28-64',
    GITHUB_REF_NAME: 'lpcox-smoke-pins-v0-28-64',
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF: 'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor-copilot.lock.yml@refs/heads/lpcox-smoke-pins-v0-28-64',
  };
  const dependencies = () => ({
    assertTrustedHostTool: jest.fn().mockResolvedValue(undefined),
    calculateSha256: jest.fn().mockResolvedValue(sha256),
    realpath: jest.fn().mockResolvedValue(DEVELOPMENT_ENCLAVE_SUPERVISOR_PATH),
  });

  afterEach(() => jest.restoreAllMocks());

  it('leaves the release path unchanged without an explicit opt-in', async () => {
    const deps = dependencies();
    await expect(resolveDevelopmentEnclaveSupervisor({}, false, deps)).resolves.toBeUndefined();
    expect(deps.realpath).not.toHaveBeenCalled();
  });

  it('verifies the fixed binary and visibly labels the checksum as unattested', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const deps = dependencies();
    await expect(resolveDevelopmentEnclaveSupervisor(environment, true, deps)).resolves.toEqual({
      path: DEVELOPMENT_ENCLAVE_SUPERVISOR_PATH, sha256,
    });
    expect(deps.assertTrustedHostTool).toHaveBeenCalledWith(
      'development enclave supervisor', DEVELOPMENT_ENCLAVE_SUPERVISOR_PATH,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNATTESTED DEVELOPMENT'));
  });

  it.each([
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_REPOSITORY', 'other/repository'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_REF_TYPE', 'tag'],
    ['GITHUB_REF', 'refs/heads/main'],
    ['GITHUB_REF_NAME', 'main'],
    ['GITHUB_SHA', 'invalid'],
    ['GITHUB_WORKFLOW_SHA', 'c'.repeat(40)],
    ['GITHUB_WORKFLOW_REF', 'other/workflow@refs/heads/lpcox-smoke-pins-v0-28-64'],
    ['AWF_CH_ENCLAVE_TEST_SUPERVISOR_SHA256', 'invalid'],
  ])('rejects a mismatched %s before inspecting any file', async (key, value) => {
    const deps = dependencies();
    await expect(resolveDevelopmentEnclaveSupervisor({ ...environment, [key]: value }, true, deps))
      .rejects.toThrow('restricted to the verified public PR smoke');
    expect(deps.realpath).not.toHaveBeenCalled();
  });

  it('requires verified public-fixture debug isolation', async () => {
    await expect(resolveDevelopmentEnclaveSupervisor(environment, false, dependencies()))
      .rejects.toThrow('restricted to the verified public PR smoke');
  });

  it('rejects symlinked paths, untrusted binaries, and changed checksums', async () => {
    const deps = dependencies();
    deps.realpath.mockResolvedValueOnce('/other/file');
    await expect(resolveDevelopmentEnclaveSupervisor(environment, true, deps))
      .rejects.toThrow('canonical host-only path');
    deps.assertTrustedHostTool.mockRejectedValueOnce(new Error('unsafe owner or mode'));
    await expect(resolveDevelopmentEnclaveSupervisor(environment, true, deps))
      .rejects.toThrow('unsafe owner or mode');
    deps.calculateSha256.mockResolvedValueOnce('c'.repeat(64));
    await expect(resolveDevelopmentEnclaveSupervisor(environment, true, deps))
      .rejects.toThrow('checksum mismatch');
  });
});
