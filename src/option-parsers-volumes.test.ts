import {
  parseVolumeMounts,
} from './option-parsers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('volume mount parsing', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-'));
  });

  afterEach(() => {
    // Clean up the test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should parse valid mount with read-write mode', () => {
    const mounts = [`${testDir}:/workspace:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${testDir}:/workspace:rw`]);
    }
  });

  it('should parse valid mount with read-only mode', () => {
    const mounts = [`${testDir}:/data:ro`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${testDir}:/data:ro`]);
    }
  });

  it('should parse valid mount without mode (defaults to rw)', () => {
    const mounts = [`${testDir}:/app`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${testDir}:/app`]);
    }
  });

  it('should parse multiple valid mounts', () => {
    const subdir1 = path.join(testDir, 'dir1');
    const subdir2 = path.join(testDir, 'dir2');
    fs.mkdirSync(subdir1);
    fs.mkdirSync(subdir2);

    const mounts = [`${subdir1}:/workspace:ro`, `${subdir2}:/data:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([`${subdir1}:/workspace:ro`, `${subdir2}:/data:rw`]);
    }
  });

  it('should reject mount with too few parts', () => {
    const mounts = ['/workspace'];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe('/workspace');
      expect(result.reason).toContain('host_path:container_path[:mode]');
    }
  });

  it('should reject mount with too many parts', () => {
    const mounts = [`${testDir}:/workspace:rw:extra`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}:/workspace:rw:extra`);
      expect(result.reason).toContain('host_path:container_path[:mode]');
    }
  });

  it('should reject mount with empty host path', () => {
    const mounts = [':/workspace:rw'];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(':/workspace:rw');
      expect(result.reason).toContain('Host path cannot be empty');
    }
  });

  it('should reject mount with empty container path', () => {
    const mounts = [`${testDir}::rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}::rw`);
      expect(result.reason).toContain('Container path cannot be empty');
    }
  });

  it('should reject mount with relative host path', () => {
    const mounts = ['./relative/path:/workspace:rw'];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe('./relative/path:/workspace:rw');
      expect(result.reason).toContain('Host path must be absolute');
    }
  });

  it('should reject mount with relative container path', () => {
    const mounts = [`${testDir}:relative/path:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}:relative/path:rw`);
      expect(result.reason).toContain('Container path must be absolute');
    }
  });

  it('should reject mount with invalid mode', () => {
    const mounts = [`${testDir}:/workspace:invalid`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${testDir}:/workspace:invalid`);
      expect(result.reason).toContain('Mount mode must be either "ro" or "rw"');
    }
  });

  it('should reject mount with non-existent host path', () => {
    const nonExistentPath = '/tmp/this-path-definitely-does-not-exist-12345';
    const mounts = [`${nonExistentPath}:/workspace:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe(`${nonExistentPath}:/workspace:rw`);
      expect(result.reason).toContain('Host path does not exist');
    }
  });

  it('should handle empty array', () => {
    const mounts: string[] = [];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.mounts).toEqual([]);
    }
  });

  it('should return error on first invalid entry', () => {
    const subdir = path.join(testDir, 'valid');
    fs.mkdirSync(subdir);

    const mounts = [`${subdir}:/workspace:ro`, 'invalid-mount', `${testDir}:/data:rw`];
    const result = parseVolumeMounts(mounts);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidMount).toBe('invalid-mount');
    }
  });
});
