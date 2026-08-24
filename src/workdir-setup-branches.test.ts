/**
 * Targeted branch-coverage tests for src/workdir-setup.ts:
 *
 * - ensureDirectory: symlink detected → throws (line 24)
 * - ensureDirectory: non-directory path → throws (line 29)
 * - assertRealDirectory: symlink → throws (line 45)
 * - assertRealDirectory: non-directory → throws (line 50)
 * - createMissingOwnedDirectorySegments: non-directory segment → throws (line 76)
 * - prepareLogDirectories: /tmp/gh-aw/mcp-logs already exists (lines 194-195 else branch)
 * - prepareChrootHomeMounts: runnerToolCachePath outside effective home → warn (line 262)
 */

// Uses the fs mock factory (wraps real fs with spies) for symlink/non-dir setup.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('fs', () => require('./test-helpers/fs-mock-factory.test-utils').fsMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-env', () => require('./test-helpers/fs-mock-factory.test-utils').hostEnvMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./host-identity', () => require('./test-helpers/fs-mock-factory.test-utils').hostIdentityMockFactory());

import { workdirSetupTestHelpers, prepareWorkDirectories } from './workdir-setup';
import { resolveLogPaths } from './log-paths';
import { getRealUserHome } from './host-identity';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-branch-test-'));
}

describe('workdir-setup – ensureDirectory symlink/non-directory error branches', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when a symlink exists where a directory is expected (line 24)', () => {
    // Create a real target and a symlink pointing to it, then pass the symlink path
    // to ensureDirectory so it triggers the "Refusing to use symlink" error.
    const realTarget = path.join(tempDir, 'real-target');
    fs.mkdirSync(realTarget);
    const symlinkPath = path.join(tempDir, 'my-symlink');
    fs.symlinkSync(realTarget, symlinkPath);

    expect(() => workdirSetupTestHelpers.ensureDirectory(symlinkPath)).toThrow(
      `Refusing to use symlink as directory: ${symlinkPath}`
    );
  });

  it('calls onCreate callback when a new directory is created', () => {
    const newDir = path.join(tempDir, 'fresh-dir');
    const onCreate = jest.fn();

    workdirSetupTestHelpers.ensureDirectory(newDir, { onCreate });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('calls onExists callback when the directory already exists', () => {
    const existingDir = path.join(tempDir, 'existing-dir');
    fs.mkdirSync(existingDir);
    const onExists = jest.fn();

    workdirSetupTestHelpers.ensureDirectory(existingDir, { onExists });

    expect(onExists).toHaveBeenCalledTimes(1);
  });

  it('calls onAfterEnsure callback regardless of creation state', () => {
    const dirPath = path.join(tempDir, 'after-ensure-dir');
    const onAfterEnsure = jest.fn();

    workdirSetupTestHelpers.ensureDirectory(dirPath, { onAfterEnsure });

    expect(onAfterEnsure).toHaveBeenCalledTimes(1);
  });
});

describe('workdir-setup – assertRealDirectory error branches', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when assertRealDirectory receives a symlink path (line 45)', () => {
    const realTarget = path.join(tempDir, 'real-dir');
    fs.mkdirSync(realTarget);
    const symlinkPath = path.join(tempDir, 'link-to-dir');
    fs.symlinkSync(realTarget, symlinkPath);

    expect(() => workdirSetupTestHelpers.assertRealDirectory(symlinkPath)).toThrow(
      `Refusing to use symlink as directory: ${symlinkPath}`
    );
  });

  it('throws when assertRealDirectory receives a file path (line 50)', () => {
    const filePath = path.join(tempDir, 'plain-file.txt');
    fs.writeFileSync(filePath, 'content');

    expect(() => workdirSetupTestHelpers.assertRealDirectory(filePath)).toThrow(
      `Expected directory but found non-directory path: ${filePath}`
    );
  });
});

describe('workdir-setup – createMissingOwnedDirectorySegments non-directory segment (line 76)', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when a path segment is a regular file rather than a directory', () => {
    // Create a file at an intermediate path segment so the loop hits a non-dir.
    const fileSegment = path.join(tempDir, 'file-segment');
    fs.writeFileSync(fileSegment, 'I am a file');
    // Now request a child path through that file segment.
    const childPath = path.join(fileSegment, 'child');

    expect(() =>
      workdirSetupTestHelpers.createMissingOwnedDirectorySegments(childPath, 1000, 1000)
    ).toThrow(`Expected directory but found non-directory path: ${fileSegment}`);
  });

  it('skips an owner-preserving chown so non-root callers do not hit EPERM', () => {
    // A freshly created directory already belongs to the caller, so chowning it
    // back to the same owner changes nothing -- but macOS still denies that
    // syscall to non-root, which used to abort mountpoint preparation.
    const created = path.join(tempDir, 'nested', 'mountpoint');
    // Read the ownership the platform actually assigns to a new directory here
    // rather than assuming the caller's ids: BSD (macOS) gives a new directory
    // its parent's gid, so under /tmp that is wheel, not the caller's group.
    const probe = path.join(tempDir, 'ownership-probe');
    fs.mkdirSync(probe);
    const { uid, gid } = fs.statSync(probe);

    workdirSetupTestHelpers.createMissingOwnedDirectorySegments(created, uid, gid);

    expect(fs.existsSync(created)).toBe(true);
    expect(fs.chownSync as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('still chowns when a privileged caller must change owner', () => {
    const created = path.join(tempDir, 'other-owner');
    const foreignUid = (process.getuid?.() ?? 0) + 1;
    const getuid = jest.spyOn(process, 'getuid').mockReturnValue(0);

    try {
      workdirSetupTestHelpers.createMissingOwnedDirectorySegments(created, foreignUid, 0);
    } finally {
      getuid.mockRestore();
    }

    expect(fs.chownSync as unknown as jest.Mock).toHaveBeenCalledWith(created, foreignUid, 0);
  });

  it('tolerates an EPERM chown a non-root caller could never satisfy', () => {
    // getSafeHostGid can map the caller onto a different gid (macOS maps a
    // system gid into the regular range). Unprivileged AWF cannot grant a
    // directory away, so this must not abort mountpoint preparation.
    const created = path.join(tempDir, 'unprivileged');
    const foreignGid = (process.getgid?.() ?? 0) + 1000;
    const getuid = jest.spyOn(process, 'getuid').mockReturnValue(501);
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => {
      const error = new Error('EPERM') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    try {
      workdirSetupTestHelpers.createMissingOwnedDirectorySegments(created, 501, foreignGid);
    } finally {
      getuid.mockRestore();
    }

    expect(fs.existsSync(created)).toBe(true);
  });

  it('still propagates a chown failure that is not a privilege limit', () => {
    const created = path.join(tempDir, 'broken');
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => {
      const error = new Error('EIO') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    });

    expect(() =>
      workdirSetupTestHelpers.createMissingOwnedDirectorySegments(created, 4242, 4242)
    ).toThrow('EIO');
  });

  it('still propagates an EPERM chown when running privileged', () => {
    const created = path.join(tempDir, 'privileged-eperm');
    const getuid = jest.spyOn(process, 'getuid').mockReturnValue(0);
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => {
      const error = new Error('EPERM') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    try {
      expect(() =>
        workdirSetupTestHelpers.createMissingOwnedDirectorySegments(created, 4242, 4242)
      ).toThrow('EPERM');
    } finally {
      getuid.mockRestore();
    }
  });
});

describe('workdir-setup – prepareLogDirectories mcp-logs already-exists branch (lines 194-195)', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(`${tempDir}-chroot-home`, { recursive: true, force: true });
  });

  it('calls chmodSync on /tmp/gh-aw/mcp-logs when directory already exists (else branch)', () => {
    // Pre-create the mcp-logs directory so ensureDirectory returns false
    // and the "Fix permissions" else branch is taken.
    const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
    fs.mkdirSync(mcpLogsDir, { recursive: true });

    const buildConfig = () => ({
      workDir: tempDir,
      sslBump: false,
      allowedDomains: [] as string[],
      agentCommand: 'echo test',
      logLevel: 'info' as const,
      keepContainers: false,
      buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
    });

    const config = buildConfig();
    const logPaths = resolveLogPaths(config);

    prepareWorkDirectories(config, logPaths);

    // The else branch always calls chmodSync to fix permissions
    expect(fs.chmodSync).toHaveBeenCalledWith(mcpLogsDir, 0o777);
  });
});

describe('workdir-setup – prepareChrootHomeMounts runnerToolCachePath outside home (line 262)', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
    tempDir = makeTempDir();
    (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(`${tempDir}-chroot-home`, { recursive: true, force: true });
  });

  it('logs a warning and skips creation when runnerToolCachePath is outside effectiveHome', () => {
    // A path that does not start with tempDir (our mocked effectiveHome)
    const outsidePath = path.join(os.tmpdir(), `outside-home-${Date.now()}`);

    const buildConfig = (overrides: Record<string, unknown> = {}) => ({
      workDir: tempDir,
      sslBump: false,
      allowedDomains: [] as string[],
      agentCommand: 'echo test',
      logLevel: 'info' as const,
      keepContainers: false,
      buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: 'latest',
      ...overrides,
    });

    // Path does not exist yet, so the `!fs.existsSync` branch is entered,
    // but since it is outside effectiveHome, the warning branch (line 262) fires.
    const config = buildConfig({ runnerToolCachePath: outsidePath });
    const logPaths = resolveLogPaths(config);

    expect(() => prepareWorkDirectories(config, logPaths)).not.toThrow();
    // The outside-home directory must NOT have been created
    expect(fs.existsSync(outsidePath)).toBe(false);
  });
});
