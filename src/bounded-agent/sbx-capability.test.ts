/* eslint-disable @typescript-eslint/no-require-imports -- container-side broker
   module is loaded at runtime for a byte-for-byte cross-check; it is a plain
   .js file with no TS types, so `require()` is the correct (and only) way to
   pull it in, matching the pattern used by src/bounded-query/*.test.ts. */
import execa from 'execa';
import path from 'path';
import {
  boundedAgentSbxCapabilityTestHelpers as helpers,
  defaultBoundedAgentSbxCapabilityQuery,
} from './sbx-capability';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const mockExeca = execa as unknown as jest.Mock;

/**
 * Host-side capability probe coverage for the bounded-agent sbx enclave
 * backend.
 *
 * This backend has a strictly harder network requirement than bounded
 * queries: an enclave must reach exactly one peer (the API proxy), not
 * "no network at all". So `missing` always includes the pinned-template and
 * lateral-peer-denial entries regardless of what flags are detected — the
 * probe can never report `supported: true` for the currently audited sbx
 * 0.37.1 CLI, by design.
 */
describe('defaultBoundedAgentSbxCapabilityQuery', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('never reports supported even when every flag is present, because the network primitive is unverifiable', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Sandboxes v0.37.1' }) // version
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]' }) // ls (daemon reachability)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '--name --cpus --memory --template --pids-limit --disk-limit --ulimit-fsize --mount-target',
      }) // create --help
      .mockResolvedValueOnce({ exitCode: 0, stdout: '--user --workdir' }); // exec --help

    const report = await defaultBoundedAgentSbxCapabilityQuery();

    expect(report.supported).toBe(false);
    expect(report.version).toBe('0.37.1');
    expect(report.auditedVersion).toBe('0.37.1');
    expect(report.missing).toContain('pinned AWF bounded-agent sbx template and bootstrap');
    expect(report.missing).toContain(
      'sbx named-network attach with mandatory lateral-peer denial to enforce API-proxy-only egress ' +
      '(hard network-policy / capability-token ingress primitive)',
    );
    // Every enumerated flag was detected, so nothing else should be missing.
    expect(report.missing).not.toContain('sbx create --network');
    expect(report.missing).not.toContain('authenticated sbx CLI/daemon');
  });

  it('reports every missing lifecycle/resource flag when help output lacks them', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Sandboxes v0.37.1' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '--name --cpus --memory --template' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '--user --workdir' });

    const report = await defaultBoundedAgentSbxCapabilityQuery();

    expect(report.supported).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining([
      'pinned AWF bounded-agent sbx template and bootstrap',
      'sbx create --pids-limit',
      'sbx create --disk-limit',
      'sbx create --ulimit-fsize',
      'sbx create --mount-target',
    ]));
  });

  it('reports an unsupported audited version distinctly from missing flags', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Sandboxes v0.99.0' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '[]' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '--name --cpus --memory --template --pids-limit --disk-limit --ulimit-fsize --mount-target',
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '--user --workdir' });

    const report = await defaultBoundedAgentSbxCapabilityQuery();
    expect(report.missing).toContain('audited sbx version 0.37.1 (found 0.99.0)');
  });

  it('reports an unauthenticated or unreachable daemon', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker Sandboxes v0.37.1' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '' }) // ls fails: daemon unreachable/unauthenticated
      .mockResolvedValueOnce({ exitCode: 0, stdout: '--name --cpus --memory --template' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '--user --workdir' });

    const report = await defaultBoundedAgentSbxCapabilityQuery();
    expect(report.missing).toContain('authenticated sbx CLI/daemon');
  });

  it('fails closed when the sbx binary is entirely absent', async () => {
    mockExeca.mockRejectedValue(new Error('spawn sbx ENOENT'));
    const report = await defaultBoundedAgentSbxCapabilityQuery();
    expect(report).toEqual({
      supported: false,
      auditedVersion: '0.37.1',
      missing: ['authenticated sbx CLI/daemon'],
    });
  });

  it('never uses request-scoped or credential-bearing environment beyond the process env', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' });
    await defaultBoundedAgentSbxCapabilityQuery();
    for (const call of mockExeca.mock.calls) {
      const options = call[2] as { env?: Record<string, string> } | undefined;
      expect(options?.env).not.toHaveProperty('DOCKER_SANDBOXES_PROXY');
      expect(options?.env).not.toHaveProperty('XDG_CONFIG_HOME');
    }
  });

  it('keeps the required-flag lists byte-for-byte aligned with the container-side probe', () => {
    const containerProbe = require(path.join(
      __dirname,
      '..',
      '..',
      'containers',
      'bounded-agent',
      'broker',
      'sbx-capability-probe.js',
    ));
    expect(helpers.SBX_AUDITED_VERSION).toBe(containerProbe.AUDITED_SBX_VERSION);
    // The host-side probe collapses REQUIRED_CREATE_FLAGS and
    // REQUIRED_HARD_ISOLATION_FLAGS into one list (it stops before staging
    // rather than launching, so it has no reason to distinguish lifecycle
    // flags from hard-isolation flags), except `--network`: host-side never
    // treats its presence as informative, because the unconditional
    // lateral-peer-denial entry already reports the network requirement
    // missing regardless of flag detection — checking the flag too would
    // only invite a false sense of partial progress.
    const containerHardIsolationWithoutNetwork = containerProbe.REQUIRED_HARD_ISOLATION_FLAGS
      .filter((flag: string) => flag !== '--network');
    expect(new Set(helpers.SBX_REQUIRED_CREATE_FLAGS)).toEqual(new Set([
      ...containerProbe.REQUIRED_CREATE_FLAGS,
      ...containerHardIsolationWithoutNetwork,
    ]));
    expect(helpers.SBX_REQUIRED_EXEC_FLAGS).toEqual(containerProbe.REQUIRED_EXEC_FLAGS);
  });
});

describe('helpIncludesFlag', () => {
  it('matches a flag as a standalone token, not a substring of another flag', () => {
    expect(helpers.helpIncludesFlag('--network, --network-mode', '--network')).toBe(true);
    expect(helpers.helpIncludesFlag('--network-mode', '--network')).toBe(false);
    expect(helpers.helpIncludesFlag('  --cpus=<n>  Number of vCPUs', '--cpus')).toBe(true);
    expect(helpers.helpIncludesFlag('no matching flags here', '--cpus')).toBe(false);
  });
});
