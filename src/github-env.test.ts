import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractGhHostFromServerUrl,
  readGitHubPathEntries,
  readGitHubEnvEntries,
  mergeGitHubPathEntries,
  readEnvFile,
  TOOLCHAIN_ENV_VARS,
} from './github-env';

describe('extractGhHostFromServerUrl', () => {
  it('should return null for github.com', () => {
    expect(extractGhHostFromServerUrl('https://github.com')).toBeNull();
  });

  it('should return null for undefined', () => {
    expect(extractGhHostFromServerUrl(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(extractGhHostFromServerUrl('')).toBeNull();
  });

  it('should extract hostname for GHES instance', () => {
    expect(extractGhHostFromServerUrl('https://github.enterprise.com')).toBe('github.enterprise.com');
  });

  it('should extract hostname for GHEC instance', () => {
    expect(extractGhHostFromServerUrl('https://ghe.github.com')).toBe('ghe.github.com');
  });

  it('should handle URLs with ports', () => {
    expect(extractGhHostFromServerUrl('https://github.internal:8443')).toBe('github.internal');
  });

  it('should handle URLs with paths', () => {
    expect(extractGhHostFromServerUrl('https://github.enterprise.com/api/v3')).toBe('github.enterprise.com');
  });

  it('should return null for invalid URLs', () => {
    expect(extractGhHostFromServerUrl('not-a-url')).toBeNull();
    expect(extractGhHostFromServerUrl('://invalid')).toBeNull();
    expect(extractGhHostFromServerUrl('http://')).toBeNull();
  });

  it('should handle localhost URLs', () => {
    expect(extractGhHostFromServerUrl('http://localhost:3000')).toBe('localhost');
  });
});

describe('readGitHubPathEntries', () => {
  let testDir: string;
  let originalGithubPath: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-path-test-'));
    originalGithubPath = process.env.GITHUB_PATH;
  });

  afterEach(() => {
    if (originalGithubPath !== undefined) {
      process.env.GITHUB_PATH = originalGithubPath;
    } else {
      delete process.env.GITHUB_PATH;
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when GITHUB_PATH is not set', () => {
    delete process.env.GITHUB_PATH;
    expect(readGitHubPathEntries()).toEqual([]);
  });

  it('should return empty array when file does not exist', () => {
    process.env.GITHUB_PATH = path.join(testDir, 'nonexistent');
    expect(readGitHubPathEntries()).toEqual([]);
  });

  it('should read single path entry', () => {
    const githubPathFile = path.join(testDir, 'github_path');
    fs.writeFileSync(githubPathFile, '/usr/local/bin\n');
    process.env.GITHUB_PATH = githubPathFile;
    expect(readGitHubPathEntries()).toEqual(['/usr/local/bin']);
  });

  it('should read multiple path entries', () => {
    const githubPathFile = path.join(testDir, 'github_path');
    fs.writeFileSync(githubPathFile, '/usr/local/bin\n/opt/ruby/bin\n/home/runner/.cargo/bin\n');
    process.env.GITHUB_PATH = githubPathFile;
    expect(readGitHubPathEntries()).toEqual([
      '/usr/local/bin',
      '/opt/ruby/bin',
      '/home/runner/.cargo/bin',
    ]);
  });

  it('should ignore empty lines', () => {
    const githubPathFile = path.join(testDir, 'github_path');
    fs.writeFileSync(githubPathFile, '/usr/local/bin\n\n/opt/ruby/bin\n  \n/home/runner/.cargo/bin\n');
    process.env.GITHUB_PATH = githubPathFile;
    expect(readGitHubPathEntries()).toEqual([
      '/usr/local/bin',
      '/opt/ruby/bin',
      '/home/runner/.cargo/bin',
    ]);
  });

  it('should trim whitespace from entries', () => {
    const githubPathFile = path.join(testDir, 'github_path');
    fs.writeFileSync(githubPathFile, '  /usr/local/bin  \n\t/opt/ruby/bin\t\n');
    process.env.GITHUB_PATH = githubPathFile;
    expect(readGitHubPathEntries()).toEqual([
      '/usr/local/bin',
      '/opt/ruby/bin',
    ]);
  });

  it('should handle empty file', () => {
    const githubPathFile = path.join(testDir, 'github_path');
    fs.writeFileSync(githubPathFile, '');
    process.env.GITHUB_PATH = githubPathFile;
    expect(readGitHubPathEntries()).toEqual([]);
  });

  it('should handle file with only whitespace', () => {
    const githubPathFile = path.join(testDir, 'github_path');
    fs.writeFileSync(githubPathFile, '  \n  \n  \n');
    process.env.GITHUB_PATH = githubPathFile;
    expect(readGitHubPathEntries()).toEqual([]);
  });
});

describe('parseGitHubEnvFile (via readGitHubEnvEntries)', () => {
  let testDir: string;
  let originalGithubEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-parse-env-test-'));
    originalGithubEnv = process.env.GITHUB_ENV;
  });

  afterEach(() => {
    if (originalGithubEnv !== undefined) {
      process.env.GITHUB_ENV = originalGithubEnv;
    } else {
      delete process.env.GITHUB_ENV;
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function parseViaPublicApi(content: string): Record<string, string> {
    const envFile = path.join(testDir, 'env');
    fs.writeFileSync(envFile, content);
    process.env.GITHUB_ENV = envFile;
    return readGitHubEnvEntries();
  }

  describe('simple format', () => {
    it('should parse single KEY=VALUE line', () => {
      expect(parseViaPublicApi('FOO=bar\n')).toEqual({ FOO: 'bar' });
    });

    it('should parse multiple KEY=VALUE lines', () => {
      expect(parseViaPublicApi('FOO=bar\nBAZ=qux\n')).toEqual({
        FOO: 'bar',
        BAZ: 'qux',
      });
    });

    it('should handle values with equals signs', () => {
      expect(parseViaPublicApi('URL=https://example.com?key=value\n')).toEqual({
        URL: 'https://example.com?key=value',
      });
    });

    it('should handle empty values', () => {
      expect(parseViaPublicApi('EMPTY=\n')).toEqual({ EMPTY: '' });
    });

    it('should ignore empty lines', () => {
      expect(parseViaPublicApi('FOO=bar\n\nBAZ=qux\n')).toEqual({
        FOO: 'bar',
        BAZ: 'qux',
      });
    });

    it('should ignore whitespace-only lines', () => {
      expect(parseViaPublicApi('FOO=bar\n  \t\nBAZ=qux\n')).toEqual({
        FOO: 'bar',
        BAZ: 'qux',
      });
    });

    it('should handle values with spaces', () => {
      expect(parseViaPublicApi('MESSAGE=hello world\n')).toEqual({
        MESSAGE: 'hello world',
      });
    });
  });

  describe('heredoc format', () => {
    it('should parse single-line heredoc', () => {
      const input = 'FOO<<EOF\nbar\nEOF\n';
      expect(parseViaPublicApi(input)).toEqual({ FOO: 'bar' });
    });

    it('should parse multi-line heredoc', () => {
      const input = 'FOO<<EOF\nline1\nline2\nline3\nEOF\n';
      expect(parseViaPublicApi(input)).toEqual({
        FOO: 'line1\nline2\nline3',
      });
    });

    it('should parse heredoc with custom delimiter', () => {
      const input = 'FOO<<DELIMITER\nvalue\nDELIMITER\n';
      expect(parseViaPublicApi(input)).toEqual({ FOO: 'value' });
    });

    it('should handle multiple heredocs', () => {
      const input = 'FOO<<EOF\nfoo value\nEOF\nBAR<<END\nbar value\nEND\n';
      expect(parseViaPublicApi(input)).toEqual({
        FOO: 'foo value',
        BAR: 'bar value',
      });
    });

    it('should handle mixed simple and heredoc format', () => {
      const input = 'SIMPLE=value\nHEREDOC<<EOF\nmulti\nline\nEOF\nANOTHER=simple\n';
      expect(parseViaPublicApi(input)).toEqual({
        SIMPLE: 'value',
        HEREDOC: 'multi\nline',
        ANOTHER: 'simple',
      });
    });

    it('should handle heredoc with empty content', () => {
      const input = 'FOO<<EOF\nEOF\n';
      expect(parseViaPublicApi(input)).toEqual({ FOO: '' });
    });

    it('should handle heredoc with equals signs in content', () => {
      const input = 'URL<<EOF\nhttps://example.com?key=value&foo=bar\nEOF\n';
      expect(parseViaPublicApi(input)).toEqual({
        URL: 'https://example.com?key=value&foo=bar',
      });
    });
  });

  describe('CRLF handling', () => {
    it('should normalize CRLF to LF in simple format', () => {
      expect(parseViaPublicApi('FOO=bar\r\n')).toEqual({ FOO: 'bar' });
    });

    it('should normalize CRLF to LF in heredoc', () => {
      const input = 'FOO<<EOF\r\nline1\r\nline2\r\nEOF\r\n';
      expect(parseViaPublicApi(input)).toEqual({
        FOO: 'line1\nline2',
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      expect(parseViaPublicApi('')).toEqual({});
    });

    it('should ignore lines without equals sign (simple format)', () => {
      expect(parseViaPublicApi('FOO=bar\nINVALID\nBAZ=qux\n')).toEqual({
        FOO: 'bar',
        BAZ: 'qux',
      });
    });

    it('should handle unclosed heredoc gracefully', () => {
      // Missing closing delimiter - all remaining lines become the value
      const input = 'FOO<<EOF\nline1\nline2\n';
      expect(parseViaPublicApi(input)).toEqual({
        FOO: 'line1\nline2\n',
      });
    });

    it('should handle heredoc with delimiter appearing in content', () => {
      // Only exact match on its own line closes heredoc
      const input = 'FOO<<EOF\nEOF is in this line\nEOF\n';
      expect(parseViaPublicApi(input)).toEqual({
        FOO: 'EOF is in this line',
      });
    });
  });
});

describe('readGitHubEnvEntries', () => {
  let testDir: string;
  let originalGithubEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-env-test-'));
    originalGithubEnv = process.env.GITHUB_ENV;
  });

  afterEach(() => {
    if (originalGithubEnv !== undefined) {
      process.env.GITHUB_ENV = originalGithubEnv;
    } else {
      delete process.env.GITHUB_ENV;
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty object when GITHUB_ENV is not set', () => {
    delete process.env.GITHUB_ENV;
    expect(readGitHubEnvEntries()).toEqual({});
  });

  it('should return empty object when file does not exist', () => {
    process.env.GITHUB_ENV = path.join(testDir, 'nonexistent');
    expect(readGitHubEnvEntries()).toEqual({});
  });

  it('should read entries from file', () => {
    const githubEnvFile = path.join(testDir, 'github_env');
    fs.writeFileSync(githubEnvFile, 'FOO=bar\nBAZ=qux\n');
    process.env.GITHUB_ENV = githubEnvFile;
    expect(readGitHubEnvEntries()).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should handle heredoc format', () => {
    const githubEnvFile = path.join(testDir, 'github_env');
    fs.writeFileSync(githubEnvFile, 'MULTI<<EOF\nline1\nline2\nEOF\n');
    process.env.GITHUB_ENV = githubEnvFile;
    expect(readGitHubEnvEntries()).toEqual({
      MULTI: 'line1\nline2',
    });
  });
});

describe('mergeGitHubPathEntries', () => {
  it('should return current path when github path entries are empty', () => {
    const currentPath = '/usr/bin:/usr/local/bin';
    expect(mergeGitHubPathEntries(currentPath, [])).toBe(currentPath);
  });

  it('should prepend new entries', () => {
    const currentPath = '/usr/bin:/usr/local/bin';
    const githubEntries = ['/opt/ruby/bin'];
    expect(mergeGitHubPathEntries(currentPath, githubEntries)).toBe(
      '/opt/ruby/bin:/usr/bin:/usr/local/bin'
    );
  });

  it('should prepend multiple new entries in order', () => {
    const currentPath = '/usr/bin';
    const githubEntries = ['/opt/ruby/bin', '/home/runner/.cargo/bin'];
    expect(mergeGitHubPathEntries(currentPath, githubEntries)).toBe(
      '/opt/ruby/bin:/home/runner/.cargo/bin:/usr/bin'
    );
  });

  it('should skip entries that already exist in current path', () => {
    const currentPath = '/usr/bin:/usr/local/bin:/opt/ruby/bin';
    const githubEntries = ['/opt/ruby/bin', '/home/runner/.cargo/bin'];
    expect(mergeGitHubPathEntries(currentPath, githubEntries)).toBe(
      '/home/runner/.cargo/bin:/usr/bin:/usr/local/bin:/opt/ruby/bin'
    );
  });

  it('should handle empty current path', () => {
    const githubEntries = ['/opt/ruby/bin'];
    expect(mergeGitHubPathEntries('', githubEntries)).toBe('/opt/ruby/bin');
  });

  it('should return current path when all github entries already exist', () => {
    const currentPath = '/usr/bin:/usr/local/bin:/opt/ruby/bin';
    const githubEntries = ['/opt/ruby/bin', '/usr/bin'];
    expect(mergeGitHubPathEntries(currentPath, githubEntries)).toBe(currentPath);
  });

  it('should handle multiple colons in path gracefully', () => {
    const currentPath = '/usr/bin::/usr/local/bin'; // Double colon creates empty entry
    const githubEntries = ['/opt/ruby/bin'];
    const result = mergeGitHubPathEntries(currentPath, githubEntries);
    expect(result).toContain('/opt/ruby/bin');
    expect(result).toContain('/usr/bin');
    expect(result).toContain('/usr/local/bin');
  });
});

describe('readEnvFile', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-env-file-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should read KEY=VALUE entries', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'FOO=bar\nBAZ=qux\n');
    expect(readEnvFile(envFile)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should ignore comments', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, '# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux\n');
    expect(readEnvFile(envFile)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should ignore empty lines', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'FOO=bar\n\nBAZ=qux\n\n');
    expect(readEnvFile(envFile)).toEqual({
      FOO: 'bar',
      BAZ: 'qux',
    });
  });

  it('should handle empty values', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'EMPTY=\n');
    expect(readEnvFile(envFile)).toEqual({ EMPTY: '' });
  });

  it('should accept keys starting with letter', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'aBC123=value\n');
    expect(readEnvFile(envFile)).toEqual({ aBC123: 'value' });
  });

  it('should accept keys starting with underscore', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, '_PRIVATE=secret\n');
    expect(readEnvFile(envFile)).toEqual({ _PRIVATE: 'secret' });
  });

  it('should reject keys starting with digit', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, '123KEY=value\n');
    expect(readEnvFile(envFile)).toEqual({});
  });

  it('should accept keys with underscores and digits', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'KEY_123_NAME=value\n');
    expect(readEnvFile(envFile)).toEqual({ KEY_123_NAME: 'value' });
  });

  it('should reject keys with hyphens', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'KEY-NAME=value\n');
    expect(readEnvFile(envFile)).toEqual({});
  });

  it('should handle values with equals signs', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'URL=https://example.com?key=value\n');
    expect(readEnvFile(envFile)).toEqual({
      URL: 'https://example.com?key=value',
    });
  });

  it('should not strip quotes from values', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'QUOTED="hello world"\n');
    expect(readEnvFile(envFile)).toEqual({
      QUOTED: '"hello world"',
    });
  });

  it('should handle whitespace in values', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, 'MESSAGE=hello world  \n');
    expect(readEnvFile(envFile)).toEqual({
      MESSAGE: 'hello world',
    });
  });

  it('should trim line whitespace before parsing values', () => {
    const envFile = path.join(testDir, 'test.env');
    fs.writeFileSync(envFile, '  FOO=bar  \n');
    // Line is trimmed, so "  FOO=bar  " becomes "FOO=bar"
    expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
  });

  it('should throw error when file does not exist', () => {
    const nonexistent = path.join(testDir, 'nonexistent.env');
    expect(() => readEnvFile(nonexistent)).toThrow();
  });

  it('should handle empty file', () => {
    const envFile = path.join(testDir, 'empty.env');
    fs.writeFileSync(envFile, '');
    expect(readEnvFile(envFile)).toEqual({});
  });

  it('should handle file with only comments', () => {
    const envFile = path.join(testDir, 'comments.env');
    fs.writeFileSync(envFile, '# Comment 1\n# Comment 2\n');
    expect(readEnvFile(envFile)).toEqual({});
  });
});

describe('TOOLCHAIN_ENV_VARS', () => {
  it('should export expected toolchain variables', () => {
    expect(TOOLCHAIN_ENV_VARS).toContain('GOROOT');
    expect(TOOLCHAIN_ENV_VARS).toContain('CARGO_HOME');
    expect(TOOLCHAIN_ENV_VARS).toContain('RUSTUP_HOME');
    expect(TOOLCHAIN_ENV_VARS).toContain('JAVA_HOME');
    expect(TOOLCHAIN_ENV_VARS).toContain('DOTNET_ROOT');
    expect(TOOLCHAIN_ENV_VARS).toContain('BUN_INSTALL');
  });

  it('should have exactly 6 toolchain variables', () => {
    expect(TOOLCHAIN_ENV_VARS).toHaveLength(6);
  });
});
