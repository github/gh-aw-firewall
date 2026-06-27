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
          '-v',
          `/host${path.resolve(auditDir)}:/fix:rw`,
          'ghcr.io/github/gh-aw-firewall/agent:latest',
        ]),
        expect.objectContaining({ reject: false }),
      );
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
