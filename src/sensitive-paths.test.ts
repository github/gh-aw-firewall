import {
  EXPLICITLY_SAFE_GH_AW_CHILDREN,
  SENSITIVE_PATHS,
  SENSITIVE_PATH_EXEMPTIONS,
  dockerSensitiveTmpfs,
  resolveSensitivePaths,
} from './sensitive-paths';

describe('sensitive path registry', () => {
  it('declares shared sensitive paths for Docker, Cloud Hypervisor, and NVX', () => {
    expect(SENSITIVE_PATHS.map(({ path: entryPath }) => entryPath)).toEqual([
      '/tmp/gh-aw/mcp-logs',
      '$workDir',
      '/tmp/gh-aw/sandbox/firewall/logs',
      '/tmp/gh-aw/sandbox/firewall/audit',
    ]);
    for (const id of ['mcp-logs', 'firewall-logs', 'firewall-audit']) {
      expect(SENSITIVE_PATHS.find((entry) => entry.id === id)?.appliesTo)
        .toEqual(['docker', 'cloud-hypervisor', 'nvx']);
    }
  });

  it('records mcp-payloads as readable and enumerates safe /tmp/gh-aw children', () => {
    expect(SENSITIVE_PATHS.some((entry) => entry.path === '/tmp/gh-aw/mcp-payloads')).toBe(false);
    expect(SENSITIVE_PATH_EXEMPTIONS).toEqual([expect.objectContaining({
      path: '/tmp/gh-aw/mcp-payloads',
      reason: expect.stringContaining('after jq filtering'),
    })]);
    expect(EXPLICITLY_SAFE_GH_AW_CHILDREN).toContain('agent');
    expect(EXPLICITLY_SAFE_GH_AW_CHILDREN).toContain('sandbox');
  });

  it('derives both Docker mount paths for each applicable registry entry', () => {
    const workDir = '/tmp/awf-sensitive-paths-test';
    const resolved = resolveSensitivePaths('docker', { workDir });
    const tmpfs = dockerSensitiveTmpfs(workDir);

    expect(resolved.map((entry) => entry.path)).toEqual([
      '/tmp/gh-aw/mcp-logs',
      workDir,
      '/tmp/gh-aw/sandbox/firewall/logs',
      '/tmp/gh-aw/sandbox/firewall/audit',
    ]);
    for (const entry of resolved) {
      expect(tmpfs).toContain(`${entry.path}:rw,noexec,nosuid,size=1m`);
      expect(tmpfs).toContain(`/host${entry.path}:rw,noexec,nosuid,size=1m`);
    }
    expect(resolveSensitivePaths('cloud-hypervisor').some((entry) => entry.id === 'work-directory'))
      .toBe(false);
  });

  it('rejects noncanonical or nonabsolute work directories', () => {
    expect(() => resolveSensitivePaths('docker', { workDir: 'relative' }))
      .toThrow(/requires a clean, absolute, non-root workDir/);
    expect(() => resolveSensitivePaths('docker', { workDir: '/tmp/../tmp/awf' }))
      .toThrow(/requires a clean, absolute, non-root workDir/);
  });
});
