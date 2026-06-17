/**
 * Tests for docker-host-staging.ts.
 * Covers shouldUseDockerHostStaging, stageHostFile, and extractCommandBinaryName.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  shouldUseDockerHostStaging,
  stageHostFile,
  extractCommandBinaryName,
  getDockerHostStageRoot,
} from './docker-host-staging';
import { WrapperConfig } from '../../types';

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-dhs-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('shouldUseDockerHostStaging', () => {
  it('returns false when prefix is undefined', () => {
    expect(shouldUseDockerHostStaging(undefined)).toBe(false);
  });

  it('returns false when prefix is an empty string', () => {
    expect(shouldUseDockerHostStaging('')).toBe(false);
  });

  it('returns false when prefix is whitespace only', () => {
    expect(shouldUseDockerHostStaging('   ')).toBe(false);
  });

  it('returns true for exactly "/tmp"', () => {
    expect(shouldUseDockerHostStaging('/tmp')).toBe(true);
  });

  it('returns true for "/tmp/" (trailing slash variant)', () => {
    expect(shouldUseDockerHostStaging('/tmp/')).toBe(true);
  });

  it('returns true for "/tmp/sub-path"', () => {
    expect(shouldUseDockerHostStaging('/tmp/sub-path')).toBe(true);
  });

  it('returns false for paths outside /tmp', () => {
    expect(shouldUseDockerHostStaging('/var/runner')).toBe(false);
    expect(shouldUseDockerHostStaging('/home/runner')).toBe(false);
  });

  it('returns false for a prefix that is a subdirectory of something that starts with /tmp in its name but is not /tmp', () => {
    // "/tmpfoo" is not /tmp and does not start with /tmp/
    expect(shouldUseDockerHostStaging('/tmpfoo')).toBe(false);
  });

  it('returns true for prefix without leading slash when it resolves to /tmp', () => {
    // normalizeDockerHostPathPrefix adds the leading slash
    expect(shouldUseDockerHostStaging('tmp')).toBe(true);
  });
});

describe('getDockerHostStageRoot', () => {
  it('uses workDir as stageRoot when prefix is not a /tmp path', () => {
    const config = makeConfig({ workDir: tmpDir, dockerHostPathPrefix: '/var/runner' });
    const stageRoot = getDockerHostStageRoot(config);
    expect(stageRoot).toContain(tmpDir);
    expect(fs.existsSync(stageRoot)).toBe(true);
  });

  it('uses normalizedPrefix as stageRoot for /tmp-based prefixes', () => {
    const config = makeConfig({ workDir: tmpDir, dockerHostPathPrefix: tmpDir });
    const stageRoot = getDockerHostStageRoot(config);
    expect(stageRoot).toContain(tmpDir);
    expect(fs.existsSync(stageRoot)).toBe(true);
  });

  it('creates the stage root directory', () => {
    const config = makeConfig({ workDir: tmpDir });
    const stageRoot = getDockerHostStageRoot(config);
    expect(fs.existsSync(stageRoot)).toBe(true);
    expect(fs.statSync(stageRoot).isDirectory()).toBe(true);
  });
});

describe('stageHostFile', () => {
  it('returns undefined when the source path does not exist', () => {
    const config = makeConfig({ workDir: tmpDir });
    const result = stageHostFile(config, '/nonexistent/path/file.txt', 'etc/file.txt');
    expect(result).toBeUndefined();
  });

  it('returns undefined when source path is a directory, not a file', () => {
    const config = makeConfig({ workDir: tmpDir });
    // Pass a directory path as the source
    const result = stageHostFile(config, tmpDir, 'etc/notfile.txt');
    expect(result).toBeUndefined();
  });

  it('copies the file to the stage root and returns the destination path', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    fs.writeFileSync(srcFile, 'hello staging');

    const config = makeConfig({ workDir: tmpDir });
    const result = stageHostFile(config, srcFile, 'etc/source.txt');
    expect(result).toBeDefined();
    expect(fs.readFileSync(result!, 'utf8')).toBe('hello staging');
  });

  it('returns undefined when relativeTargetPath would escape the stage root (path traversal)', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    fs.writeFileSync(srcFile, 'data');
    const config = makeConfig({ workDir: tmpDir });
    const result = stageHostFile(config, srcFile, '../../etc/passwd');
    expect(result).toBeUndefined();
  });

  it('returns undefined when relativeTargetPath normalizes to empty string', () => {
    const srcFile = path.join(tmpDir, 'source.txt');
    fs.writeFileSync(srcFile, 'data');
    const config = makeConfig({ workDir: tmpDir });
    // A relative path that after stripping leading slashes is empty should be rejected
    const result = stageHostFile(config, srcFile, '/');
    expect(result).toBeUndefined();
  });

  it('creates nested directories as needed within the stage root', () => {
    const srcFile = path.join(tmpDir, 'cert.pem');
    fs.writeFileSync(srcFile, 'cert-data');
    const config = makeConfig({ workDir: tmpDir });
    const result = stageHostFile(config, srcFile, 'ssl/certs/cert.pem');
    expect(result).toBeDefined();
    expect(fs.existsSync(result!)).toBe(true);
  });

  it('applies the specified file mode', () => {
    const srcFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(srcFile, 'secret');
    const config = makeConfig({ workDir: tmpDir });
    const result = stageHostFile(config, srcFile, 'secrets/secret.txt', 0o600);
    expect(result).toBeDefined();
    const mode = fs.statSync(result!).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('extractCommandBinaryName', () => {
  it('returns the binary name for a simple command', () => {
    expect(extractCommandBinaryName('curl https://example.com')).toBe('curl');
  });

  it('returns the binary name for a command with a path prefix', () => {
    expect(extractCommandBinaryName('/usr/bin/curl -s https://example.com')).toBe('curl');
  });

  it('returns undefined for an empty string', () => {
    expect(extractCommandBinaryName('')).toBeUndefined();
  });

  it('returns undefined for a whitespace-only string', () => {
    expect(extractCommandBinaryName('   ')).toBeUndefined();
  });

  it('returns undefined when the binary basename contains unsafe characters', () => {
    // A binary like "../../malicious" has basename "malicious" which IS safe,
    // but we test the regex: a name with a null byte or shell metachar is unsafe
    expect(extractCommandBinaryName('/bin/my;cmd arg')).toBeUndefined();
  });

  it('allows dots and hyphens in binary names', () => {
    expect(extractCommandBinaryName('node.js-runner --flag')).toBe('node.js-runner');
  });

  it('handles command without arguments', () => {
    expect(extractCommandBinaryName('ls')).toBe('ls');
  });
});
