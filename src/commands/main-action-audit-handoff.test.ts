import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testHelpers } from './main-action';
import { MAIN_ACTION_STUB_CONFIG } from './main-action.test-utils';
import { logger } from '../logger';
import { stopCloudHypervisorEnclaveLifecycle } from '../enclave/cloud-hypervisor-lifecycle';
import { cleanup as cleanupWorkDirectory } from '../docker-manager';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { verifyPublicEnclaveDebugRepositories } from '../enclave/public-debug';
import type { WrapperConfig } from '../types';

jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual('fs') }));
jest.mock('../enclave/cloud-hypervisor-lifecycle');
jest.mock('../docker-manager');

describe('resolved configuration startup artifact handoff', () => {
  let directory: string;
  beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-config-handoff-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('hands diagnostics to the runner even when visibility preflight and fatal cleanup fail', async () => {
    const auditDir = path.join(directory, 'audit');
    const privateRoot = path.join(directory, 'recovery');
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const journal = path.join(privateRoot, 'state');
    fs.writeFileSync(journal, 'PRIVATE_SENTINEL', { mode: 0o600 });
    const handoffs: string[] = [];
    const effectiveUid = jest.spyOn(process, 'getuid').mockReturnValue(0);
    const effectiveGid = jest.spyOn(process, 'getgid').mockReturnValue(0);
    const chown = jest.spyOn(fs, 'fchownSync').mockImplementation((fd, uid, gid) => {
      expect(uid).toBe(1001);
      expect(gid).toBe(1002);
      const stat = fs.fstatSync(fd);
      handoffs.push(stat.isDirectory() ? 'directory'
        : fs.readFileSync(path.join(auditDir, 'awf-resolved-config.json'), 'utf8'));
    });
    const uid = process.env.SUDO_UID;
    const gid = process.env.SUDO_GID;
    process.env.SUDO_UID = '1001';
    process.env.SUDO_GID = '1002';
    const config: WrapperConfig = {
      ...MAIN_ACTION_STUB_CONFIG, workDir: directory, auditDir,
      proxyLogsDir: path.join(directory, 'logs'),
      cloudHypervisor: {
        previewEnabled: true, enclaveDebugPublic: true, mountPolicy: 'workspace-only',
        cloudHypervisorBinary: '/usr/bin/cloud-hypervisor', vcpuCount: 2, memoryMib: 4096,
        apiTimeoutMs: 5000,
      },
      enclaves: normalizeEnclavesConfig([{
        script: {}, runtime: 'cloud-hypervisor',
        repos: [{ repo: 'octo/fixture', sensitivity: 'public' }],
      }]),
    };
    try {
      testHelpers.persistConfigAuditArtifact(config, { state: 'preflight' });
      effectiveUid.mockRestore();
      effectiveGid.mockRestore();
      const request = jest.fn().mockResolvedValue(new Response('{}', { status: 403 }));
      await expect(verifyPublicEnclaveDebugRepositories(config, request)).rejects.toThrow('status=403');
      expect(testHelpers.writeStartupFailureDiagnostic(config, new Error('visibility preflight failed'))).toBe('written');
      jest.mocked(stopCloudHypervisorEnclaveLifecycle).mockRejectedValueOnce(new Error('cleanup uncertain'));
      const cleanup = testHelpers.buildCleanupFn(config, () => false, () => false);
      await expect(cleanup()).rejects.toThrow('cleanup uncertain');
      expect(cleanupWorkDirectory).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(auditDir, 'enclave.jsonl'))).toBe(false);
    } finally {
      if (uid === undefined) delete process.env.SUDO_UID; else process.env.SUDO_UID = uid;
      if (gid === undefined) delete process.env.SUDO_GID; else process.env.SUDO_GID = gid;
    }
    expect(chown).toHaveBeenCalledTimes(2);
    expect(handoffs).toEqual(['directory', expect.stringContaining('"preflight"')]);
    expect(fs.statSync(auditDir).mode & 0o777).toBe(0o700);
    const file = path.join(auditDir, 'awf-resolved-config.json');
    const artifactFd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(artifactFd).mode & 0o777).toBe(0o600);
      // The runner's redactor needs to read and replace this file, not just upload it.
      expect(fs.readFileSync(artifactFd, 'utf8')).toContain('"preflight"');
      fs.ftruncateSync(artifactFd, 0);
      fs.writeSync(artifactFd, '[REDACTED]', 0, 'utf8');
      const redacted = Buffer.alloc(Buffer.byteLength('[REDACTED]'));
      fs.readSync(artifactFd, redacted, 0, redacted.length, 0);
      expect(redacted.toString('utf8')).toBe('[REDACTED]');
    } finally {
      fs.closeSync(artifactFd);
    }
    expect(fs.statSync(privateRoot).mode & 0o777).toBe(0o700);
    const journalFd = fs.openSync(journal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(journalFd).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(journalFd, 'utf8')).toBe('PRIVATE_SENTINEL');
    } finally {
      fs.closeSync(journalFd);
    }
  });

  it('keeps exclusive creation and reports a failed handoff instead of claiming preservation', () => {
    const auditDir = path.join(directory, 'audit');
    fs.mkdirSync(auditDir, { mode: 0o700 });
    const artifact = path.join(auditDir, 'awf-resolved-config.json');
    fs.writeFileSync(artifact, 'existing', { mode: 0o600 });
    const warning = jest.spyOn(logger, 'warn').mockImplementation();
    testHelpers.persistConfigAuditArtifact({ ...MAIN_ACTION_STUB_CONFIG, auditDir }, {});
    expect(fs.readFileSync(artifact, 'utf8')).toBe('existing');
    expect(warning).toHaveBeenCalledWith(
      'Failed to publish resolved config artifact:', expect.objectContaining({ code: 'EEXIST' }),
    );
  });

  it('rejects a symlink audit directory without changing its target', () => {
    const target = path.join(directory, 'target');
    fs.mkdirSync(target, { mode: 0o700 });
    const auditDir = path.join(directory, 'audit');
    fs.symlinkSync(target, auditDir);
    const warning = jest.spyOn(logger, 'warn').mockImplementation();
    testHelpers.persistConfigAuditArtifact({ ...MAIN_ACTION_STUB_CONFIG, auditDir }, {});
    expect(fs.readdirSync(target)).toEqual([]);
    expect(warning).toHaveBeenCalled();
  });
});
