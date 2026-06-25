/**
 * Branch-coverage tests targeting uncovered paths in:
 *   - src/services/agent-volumes/etc-mounts.ts   (9 uncovered branches)
 *   - src/services/agent-volumes/system-mounts.ts (3 uncovered branches)
 *   - src/services/api-proxy-service.ts           (1 uncovered branch – error path)
 *   - src/services/doh-proxy-service.ts           (1 uncovered branch – error path)
 *   - src/host-iptables-chain.ts                  (2 uncovered branches)
 */

/* eslint-disable security/detect-non-literal-fs-filename */

// ─── execa mock must be declared before any imports that use it ───────────────
jest.mock('execa');
jest.mock('./docker-manager', () => ({
  getLocalDockerEnv: () => process.env,
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import execa from 'execa';
import { buildEtcMounts } from './services/agent-volumes/etc-mounts';
import { buildSystemMounts } from './services/agent-volumes/system-mounts';
import { buildApiProxyService } from './services/api-proxy-service';
import { buildDohProxyService } from './services/doh-proxy-service';
import { checkPermissionsAndSetupChain } from './host-iptables-chain';
import * as hostIdentity from './host-identity';
import * as dockerHostStaging from './services/agent-volumes/docker-host-staging';
import { WrapperConfig } from './types';
import type { NetworkConfig, ImageBuildConfig } from './services/squid-service';

// ─── helpers ─────────────────────────────────────────────────────────────────

type MockedExecaFn = (file: string, args?: readonly string[], options?: unknown) => Promise<unknown>;
const mockedExeca = execa as unknown as jest.MockedFunction<MockedExecaFn>;

function execaResult(overrides: { exitCode?: number; stdout?: string; stderr?: string } = {}): unknown {
  return {
    command: '',
    escapedCommand: '',
    exitCode: 0,
    stdout: '',
    stderr: '',
    failed: false,
    timedOut: false,
    killed: false,
    isCanceled: false,
    ...overrides,
  };
}

function makeMinimalConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// etc-mounts branch coverage
// ─────────────────────────────────────────────────────────────────────────────
describe('etc-mounts branch coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-etc-br-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helpers for DinD-mode mocking
  function setupDinDMocks(
    uid: string,
    gid: string,
    stageRoot: string,
    stagedPasswdPath: string | undefined,
    stagedGroupPath: string | undefined,
  ): void {
    jest.spyOn(hostIdentity, 'getSafeHostUid').mockReturnValue(uid);
    jest.spyOn(hostIdentity, 'getSafeHostGid').mockReturnValue(gid);
    jest.spyOn(dockerHostStaging, 'shouldUseDockerHostStaging').mockReturnValue(true);
    jest.spyOn(dockerHostStaging, 'getDockerHostStageRoot').mockReturnValue(stageRoot);
    jest.spyOn(dockerHostStaging, 'stageHostFile').mockImplementation((_cfg, srcPath) => {
      if (srcPath === '/etc/passwd') return stagedPasswdPath;
      if (srcPath === '/etc/group') return stagedGroupPath;
      return undefined;
    });
  }

  function makeStagedFiles(
    dir: string,
    passwdContent: string,
    groupContent: string,
  ): { passwd: string; group: string } {
    const passwd = path.join(dir, 'etc', 'passwd');
    const group = path.join(dir, 'etc', 'group');
    fs.mkdirSync(path.dirname(passwd), { recursive: true });
    fs.writeFileSync(passwd, passwdContent);
    fs.writeFileSync(group, groupContent);
    return { passwd, group };
  }

  // ── resolveUniqueName: preferredName absent → baseName = preferredName (lines 48-49) ──
  it('uses preferredName directly when it is absent from staged content', () => {
    // 'runner' is NOT in the staged passwd, so baseName stays 'runner' (no -ID suffix).
    // The UID is also absent → supplement is added as 'runner:x:...'
    const uid = '919191';
    const gid = '929292';
    const stageDir = path.join(tmpDir, 'stage');
    const { passwd, group } = makeStagedFiles(
      stageDir,
      'root:x:0:0:root:/root:/bin/bash\n',
      'root:x:0:\n',
    );

    setupDinDMocks(uid, gid, stageDir, passwd, group);

    const config = makeMinimalConfig({ dockerHostPathPrefix: '/dind', workDir: tmpDir });
    const mounts = buildEtcMounts(config);

    const passwdPath = mounts.find(m => m.includes('/host/etc/passwd'))!.split(':')[0];
    const content = fs.readFileSync(passwdPath, 'utf8');

    // Should use bare 'runner' (no -919191 suffix) since 'runner' is absent
    expect(content).toContain('runner:x:919191:');
    expect(content).not.toContain('runner-919191');
  });

  // ── resolveUniqueName: both preferredName and preferredName-ID exist → counter loop ──
  it('increments counter when preferredName and preferredName-ID both exist in staged content', () => {
    const uid = '424242';
    const gid = '434343';
    const stageDir = path.join(tmpDir, 'stage');
    const { passwd, group } = makeStagedFiles(
      stageDir,
      [
        'root:x:0:0:root:/root:/bin/bash',
        'runner:x:1000:1000:Runner:/home/runner:/bin/bash',
        // 'runner-424242' already exists — forces the while-loop counter to 1
        'runner-424242:x:500:500:Other:/home/runner-424242:/bin/bash',
      ].join('\n') + '\n',
      [
        'root:x:0:',
        'runner:x:1000:',
        // 'runner-434343' already exists — forces the while-loop counter for group too
        'runner-434343:x:900:',
      ].join('\n') + '\n',
    );

    setupDinDMocks(uid, gid, stageDir, passwd, group);

    const config = makeMinimalConfig({ dockerHostPathPrefix: '/dind', workDir: tmpDir });
    const mounts = buildEtcMounts(config);

    const passwdPath = mounts.find(m => m.includes('/host/etc/passwd'))!.split(':')[0];
    const passwdContent = fs.readFileSync(passwdPath, 'utf8');

    // Counter bumped once → 'runner-424242-1'
    expect(passwdContent).toContain('runner-424242-1:x:424242:');
  });

  // ── withTrailingNewline: content does NOT end with '\n' → newline appended (line 41) ──
  it('appends newline before the supplement entry when staged passwd lacks trailing newline', () => {
    const uid = '777777';
    const gid = '888888';
    const stageDir = path.join(tmpDir, 'stage');
    const { passwd, group } = makeStagedFiles(
      stageDir,
      // Deliberately no trailing newline
      'root:x:0:0:root:/root:/bin/bash',
      'root:x:0:',
    );

    setupDinDMocks(uid, gid, stageDir, passwd, group);

    const config = makeMinimalConfig({ dockerHostPathPrefix: '/dind', workDir: tmpDir });
    const mounts = buildEtcMounts(config);

    const passwdPath = mounts.find(m => m.includes('/host/etc/passwd'))!.split(':')[0];
    const content = fs.readFileSync(passwdPath, 'utf8');

    // newline must appear before the runner entry so entries are line-delimited
    expect(content).toMatch(/\nrunner:x:777777:/);
  });

  // ── readFileContent returns undefined → stagedContent falsy → skip supplement (line 94) ──
  it('retains original staged path when staged file is unreadable at supplement time', () => {
    const uid = '555555';
    const gid = '666666';
    // Return a path that does not exist on disk → readFileContent catches ENOENT → undefined
    const phantomPath = path.join(tmpDir, 'phantom-passwd-no-exist');
    const phantomGroup = path.join(tmpDir, 'phantom-group-no-exist');
    const stageDir = path.join(tmpDir, 'stage');
    fs.mkdirSync(stageDir, { recursive: true });

    setupDinDMocks(uid, gid, stageDir, phantomPath, phantomGroup);

    const config = makeMinimalConfig({ dockerHostPathPrefix: '/dind', workDir: tmpDir });
    const mounts = buildEtcMounts(config);

    // passwdPath stays as-is (stageHostFile return value) since readFileContent returned undefined
    const passwdMount = mounts.find(m => m.includes('/host/etc/passwd'))!;
    expect(passwdMount).toContain(phantomPath);
    expect(passwdMount).toContain(':ro');
  });

  // ── synthesizeIdentityFile failure when stageHostFile returns null (lines 82, 104, 120, 121) ──
  it('falls back to /etc/passwd and /etc/group when from-scratch synthesis fails', () => {
    // getDockerHostStageRoot throws → synthesizeIdentityFile catch → returns undefined
    // passwdPath/groupPath remain undefined → mount falls back to /etc/{passwd,group}
    jest.spyOn(hostIdentity, 'getSafeHostUid').mockReturnValue('111111');
    jest.spyOn(hostIdentity, 'getSafeHostGid').mockReturnValue('222222');
    jest.spyOn(dockerHostStaging, 'shouldUseDockerHostStaging').mockReturnValue(true);
    jest.spyOn(dockerHostStaging, 'getDockerHostStageRoot').mockImplementation(() => {
      throw new Error('stage root unavailable');
    });
    jest.spyOn(dockerHostStaging, 'stageHostFile').mockReturnValue(undefined);

    const config = makeMinimalConfig({ dockerHostPathPrefix: '/dind', workDir: tmpDir });
    const mounts = buildEtcMounts(config);

    // Both mounts fall back to the host /etc paths
    expect(mounts).toContain('/etc/passwd:/host/etc/passwd:ro');
    expect(mounts).toContain('/etc/group:/host/etc/group:ro');
  });

  // ── synthesizeIdentityFile failure during supplement (lines 94, 116) ──
  it('falls back to original staged path when supplement synthesis fails', () => {
    // stageHostFile returns paths to real files that lack the UID/GID,
    // but getDockerHostStageRoot throws so synthesizeIdentityFile returns undefined.
    // The || fallback should retain the original staged path.
    const uid = '333333';
    const gid = '444444';
    const stageDir = path.join(tmpDir, 'staged');
    const { passwd, group } = makeStagedFiles(
      stageDir,
      'root:x:0:0:root:/root:/bin/bash\n',
      'root:x:0:\n',
    );

    jest.spyOn(hostIdentity, 'getSafeHostUid').mockReturnValue(uid);
    jest.spyOn(hostIdentity, 'getSafeHostGid').mockReturnValue(gid);
    jest.spyOn(dockerHostStaging, 'shouldUseDockerHostStaging').mockReturnValue(true);
    // Make synthesis fail so the || passwdPath fallback is exercised
    jest.spyOn(dockerHostStaging, 'getDockerHostStageRoot').mockImplementation(() => {
      throw new Error('stage root unavailable');
    });
    jest.spyOn(dockerHostStaging, 'stageHostFile').mockImplementation((_cfg, srcPath) => {
      if (srcPath === '/etc/passwd') return passwd;
      if (srcPath === '/etc/group') return group;
      return undefined;
    });

    const config = makeMinimalConfig({ dockerHostPathPrefix: '/dind', workDir: tmpDir });
    const mounts = buildEtcMounts(config);

    // Synthesize supplement failed → falls back to original staged paths
    const passwdMount = mounts.find(m => m.includes('/host/etc/passwd'))!;
    const groupMount = mounts.find(m => m.includes('/host/etc/group'))!;
    expect(passwdMount).toContain(passwd);
    expect(groupMount).toContain(group);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// system-mounts branch coverage
// ─────────────────────────────────────────────────────────────────────────────
describe('system-mounts branch coverage', () => {
  it('excludes runner-bin mount when chrootBinariesSourcePath is a relative path', () => {
    // Exercises normalizeChrootBinariesSourcePath: !trimmed.startsWith('/') → undefined
    const mounts = buildSystemMounts('/workspace', 'relative/path');
    expect(mounts.every(m => !m.includes('awf-runner-bin'))).toBe(true);
  });

  it('excludes runner-bin mount when chrootBinariesSourcePath is just "/"', () => {
    // Exercises: replace removes trailing slash → '' || '/' → '/' → return undefined
    const mounts = buildSystemMounts('/workspace', '/');
    expect(mounts.every(m => !m.includes('awf-runner-bin'))).toBe(true);
  });

  it('strips trailing slashes from chrootBinariesSourcePath', () => {
    const mounts = buildSystemMounts('/workspace', '/custom/tools/');
    expect(mounts).toContain('/custom/tools:/host/tmp/awf-runner-bin:ro');
  });

  it('excludes runner-bin mount when chrootBinariesSourcePath is whitespace-only', () => {
    const mounts = buildSystemMounts('/workspace', '   ');
    expect(mounts.every(m => !m.includes('awf-runner-bin'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// api-proxy-service error path
// ─────────────────────────────────────────────────────────────────────────────
describe('api-proxy-service: missing proxyIp', () => {
  it('throws when networkConfig.proxyIp is undefined', () => {
    const networkConfig: NetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
      // proxyIp intentionally absent
    };
    const imageConfig = { useGHCR: false, registry: '', parsedTag: {} as ImageBuildConfig['parsedTag'], projectRoot: '' };
    expect(() =>
      buildApiProxyService({
        config: makeMinimalConfig(),
        networkConfig,
        apiProxyLogsPath: '/tmp/logs',
        imageConfig,
      })
    ).toThrow('buildApiProxyService: networkConfig.proxyIp is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doh-proxy-service error path
// ─────────────────────────────────────────────────────────────────────────────
describe('doh-proxy-service: missing required fields', () => {
  it('throws when networkConfig.dohProxyIp is missing', () => {
    const networkConfig: NetworkConfig = { subnet: '172.30.0.0/24', squidIp: '172.30.0.10', agentIp: '172.30.0.20' };
    expect(() =>
      buildDohProxyService({
        config: { dnsOverHttps: 'https://dns.google/dns-query' } as WrapperConfig,
        networkConfig,
      })
    ).toThrow('buildDohProxyService: dohProxyIp and dnsOverHttps are required');
  });

  it('throws when config.dnsOverHttps is missing', () => {
    const networkConfig: NetworkConfig = {
      subnet: '172.30.0.0/24',
      squidIp: '172.30.0.10',
      agentIp: '172.30.0.20',
      dohProxyIp: '172.30.0.40',
    };
    expect(() =>
      buildDohProxyService({
        config: makeMinimalConfig(),
        networkConfig,
      })
    ).toThrow('buildDohProxyService: dohProxyIp and dnsOverHttps are required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// host-iptables-chain branch coverage
// ─────────────────────────────────────────────────────────────────────────────
describe('host-iptables-chain branch coverage', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  // line 10 block=0 branch=1: iptables --version throws a non-ENOENT error → re-thrown
  it('re-throws iptables --version errors that are not "missing iptables" errors', async () => {
    const timeoutError = Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT' });
    mockedExeca.mockRejectedValueOnce(timeoutError);

    await expect(checkPermissionsAndSetupChain('FW_TEST')).rejects.toThrow('Command timed out');
  });

  // line 19 block=1 branch=0: DOCKER-USER check fails with "Permission denied" in stderr
  it('throws a human-readable error when DOCKER-USER check fails with Permission denied', async () => {
    mockedExeca
      .mockResolvedValueOnce(execaResult({ exitCode: 0 })) // iptables --version
      .mockRejectedValueOnce(
        Object.assign(new Error('iptables: Permission denied'), {
          stderr: 'iptables v1.8.7: Permission denied (you must be root)',
        })
      );

    await expect(checkPermissionsAndSetupChain('FW_TEST')).rejects.toThrow(
      'Permission denied: iptables commands require root privileges'
    );
  });
});
