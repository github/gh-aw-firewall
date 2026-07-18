jest.mock('execa', () => {
  const helper = jest.requireActual<typeof import('./test-helpers/mock-execa.test-utils')>(
    './test-helpers/mock-execa.test-utils',
  );
  return helper.execaMockFactory();
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fixArtifactPermissionsForRootless } from './artifact-permissions';
import { mockExecaSync } from './test-helpers/mock-execa.test-utils';

function makeTempDir(prefix = 'awf-artifact-perms-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('artifact-permissions', () => {
  let getuidSpy: jest.SpyInstance<number | undefined, []> | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  afterEach(() => {
    getuidSpy?.mockRestore();
    getuidSpy = undefined;
  });

  it('skips rootless permission repair when running as root', () => {
    const auditDir = makeTempDir();
    try {
      getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(0);
      fixArtifactPermissionsForRootless([auditDir], undefined, undefined, undefined, undefined);
      expect(mockExecaSync.mock.calls.some(call => call[0] === 'docker')).toBe(false);
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('logs stderr when permission repair fails', () => {
    const auditDir = makeTempDir();
    let warnSpy: jest.SpyInstance | undefined;
    try {
      getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockExecaSync.mockReturnValue({ stdout: '', stderr: 'no such image: agent:latest', exitCode: 1 });
      fixArtifactPermissionsForRootless([auditDir], undefined, undefined, undefined, undefined);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no such image: agent:latest'));
    } finally {
      warnSpy?.mockRestore();
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('logs exit code without stderr when stderr is empty', () => {
    const auditDir = makeTempDir();
    let warnSpy: jest.SpyInstance | undefined;
    try {
      getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockExecaSync.mockReturnValue({ stdout: '', stderr: '', exitCode: 1 });
      fixArtifactPermissionsForRootless([auditDir], undefined, undefined, undefined, undefined);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/failed.*exit 1/i));
      // Should NOT contain a colon suffix when stderr is empty
      const warnCall = warnSpy.mock.calls.find(c => typeof c[0] === 'string' && /exit 1/.test(c[0]));
      expect(warnCall?.[0]).not.toMatch(/exit 1\):/);
    } finally {
      warnSpy?.mockRestore();
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('logs stdout when stderr is empty and command writes only to stdout', () => {
    const auditDir = makeTempDir();
    let warnSpy: jest.SpyInstance | undefined;
    try {
      getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockExecaSync.mockReturnValue({
        stdout: '[entrypoint] Timed out waiting for iptables init container after 30s',
        stderr: '',
        exitCode: 1,
      });
      fixArtifactPermissionsForRootless([auditDir], undefined, undefined, undefined, undefined);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Timed out waiting for iptables init container'));
    } finally {
      warnSpy?.mockRestore();
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('does not warn for benign permission errors on restricted runners', () => {
    const auditDir = makeTempDir();
    let errorSpy: jest.SpyInstance | undefined;
    try {
      getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockExecaSync.mockReturnValue({
        stdout: '',
        stderr: 'chmod: /fix: Operation not permitted',
        exitCode: 1,
      });
      fixArtifactPermissionsForRootless([auditDir], undefined, undefined, undefined, undefined);
      // At the default 'info' log level, the benign case is logged at debug
      // (suppressed) and must never surface as a [WARN] ... failed message.
      const warnedFailure = (errorSpy.mock.calls as unknown[][]).some(
        call => typeof call[0] === 'string' && /\[WARN\].*repair failed/i.test(call[0]),
      );
      expect(warnedFailure).toBe(false);
    } finally {
      errorSpy?.mockRestore();
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  it('runs rootless permission repair with translated mount paths', () => {
    const auditDir = makeTempDir();
    try {
      getuidSpy = jest.spyOn(process, 'getuid').mockReturnValue(1001);
      fixArtifactPermissionsForRootless(
        [auditDir],
        '/host',
        'ghcr.io/github/gh-aw-firewall',
        'latest',
        undefined,
      );
      expect(mockExecaSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'run',
          '--pull',
          'never',
          '--entrypoint',
          'sh',
          '-v',
          `/host${path.resolve(auditDir)}:/fix:rw`,
          'ghcr.io/github/gh-aw-firewall/agent:latest',
          '-c',
          'chown -R "$TUID:$TGID" /fix 2>/dev/null; chmod -R a+rwX /fix',
        ]),
        expect.objectContaining({ reject: false }),
      );
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
