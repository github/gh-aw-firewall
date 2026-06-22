import {
  readGitHubPathEntries,
  mergeGitHubPathEntries,
  readGitHubEnvEntries,
  readEnvFile,
} from './github-env';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('docker-manager GitHub env utilities', () => {
  describe('readGitHubPathEntries', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-path-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return empty array when GITHUB_PATH is not set', () => {
      const originalGithubPath = process.env.GITHUB_PATH;
      delete process.env.GITHUB_PATH;

      try {
        const result = readGitHubPathEntries();
        expect(result).toEqual([]);
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        }
      }
    });

    it('should return empty array when GITHUB_PATH file does not exist', () => {
      const originalGithubPath = process.env.GITHUB_PATH;
      process.env.GITHUB_PATH = '/nonexistent/path/to/github_path_file';

      try {
        const result = readGitHubPathEntries();
        expect(result).toEqual([]);
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
      }
    });

    it('should read path entries from GITHUB_PATH file', () => {
      const pathFile = path.join(tmpDir, 'add_path');
      fs.writeFileSync(pathFile, '/opt/hostedtoolcache/Ruby/3.3.10/x64/bin\n/opt/hostedtoolcache/Python/3.12.0/x64/bin\n');

      const originalGithubPath = process.env.GITHUB_PATH;
      process.env.GITHUB_PATH = pathFile;

      try {
        const result = readGitHubPathEntries();
        expect(result).toEqual([
          '/opt/hostedtoolcache/Ruby/3.3.10/x64/bin',
          '/opt/hostedtoolcache/Python/3.12.0/x64/bin',
        ]);
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
      }
    });

    it('should handle empty lines and whitespace in GITHUB_PATH file', () => {
      const pathFile = path.join(tmpDir, 'add_path');
      fs.writeFileSync(pathFile, '  /opt/hostedtoolcache/Ruby/3.3.10/x64/bin  \n\n  \n/opt/dart-sdk/bin\n');

      const originalGithubPath = process.env.GITHUB_PATH;
      process.env.GITHUB_PATH = pathFile;

      try {
        const result = readGitHubPathEntries();
        expect(result).toEqual([
          '/opt/hostedtoolcache/Ruby/3.3.10/x64/bin',
          '/opt/dart-sdk/bin',
        ]);
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
      }
    });

    it('should handle empty GITHUB_PATH file', () => {
      const pathFile = path.join(tmpDir, 'add_path');
      fs.writeFileSync(pathFile, '');

      const originalGithubPath = process.env.GITHUB_PATH;
      process.env.GITHUB_PATH = pathFile;

      try {
        const result = readGitHubPathEntries();
        expect(result).toEqual([]);
      } finally {
        if (originalGithubPath !== undefined) {
          process.env.GITHUB_PATH = originalGithubPath;
        } else {
          delete process.env.GITHUB_PATH;
        }
      }
    });
  });

  describe('parseGitHubEnvFile (via readGitHubEnvEntries)', () => {
    let tmpDir: string;
    let originalGithubEnv: string | undefined;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-parse-env-'));
      originalGithubEnv = process.env.GITHUB_ENV;
    });

    afterEach(() => {
      if (originalGithubEnv !== undefined) {
        process.env.GITHUB_ENV = originalGithubEnv;
      } else {
        delete process.env.GITHUB_ENV;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function parseViaPublicApi(content: string): Record<string, string> {
      const envFile = path.join(tmpDir, 'env');
      fs.writeFileSync(envFile, content);
      process.env.GITHUB_ENV = envFile;
      return readGitHubEnvEntries();
    }

    it('should parse simple KEY=VALUE entries', () => {
      const result = parseViaPublicApi('GOROOT=/usr/local/go\nJAVA_HOME=/usr/lib/jvm/java-17\n');
      expect(result).toEqual({
        GOROOT: '/usr/local/go',
        JAVA_HOME: '/usr/lib/jvm/java-17',
      });
    });

    it('should handle values containing = characters', () => {
      const result = parseViaPublicApi('MY_VAR=key=value=extra\n');
      expect(result).toEqual({ MY_VAR: 'key=value=extra' });
    });

    it('should handle heredoc multiline values', () => {
      const content = 'MULTI_LINE<<EOF\nline1\nline2\nline3\nEOF\n';
      const result = parseViaPublicApi(content);
      expect(result).toEqual({ MULTI_LINE: 'line1\nline2\nline3' });
    });

    it('should handle CRLF line endings', () => {
      const result = parseViaPublicApi('GOROOT=/usr/local/go\r\nJAVA_HOME=/usr/lib/jvm\r\n');
      expect(result).toEqual({
        GOROOT: '/usr/local/go',
        JAVA_HOME: '/usr/lib/jvm',
      });
    });

    it('should handle mixed simple and heredoc entries', () => {
      const content = 'SIMPLE=value\nHEREDOC<<END\nmulti\nline\nEND\nANOTHER=val2\n';
      const result = parseViaPublicApi(content);
      expect(result).toEqual({
        SIMPLE: 'value',
        HEREDOC: 'multi\nline',
        ANOTHER: 'val2',
      });
    });

    it('should skip empty lines', () => {
      const result = parseViaPublicApi('\n\nGOROOT=/go\n\n');
      expect(result).toEqual({ GOROOT: '/go' });
    });

    it('should return empty object for empty content', () => {
      expect(parseViaPublicApi('')).toEqual({});
    });

    it('should handle unterminated heredoc gracefully', () => {
      const content = 'BROKEN<<EOF\nline1\nline2';
      const result = parseViaPublicApi(content);
      expect(result).toEqual({ BROKEN: 'line1\nline2' });
    });
  });

  describe('readGitHubEnvEntries', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-github-env-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return empty object when GITHUB_ENV is not set', () => {
      const original = process.env.GITHUB_ENV;
      delete process.env.GITHUB_ENV;

      try {
        const result = readGitHubEnvEntries();
        expect(result).toEqual({});
      } finally {
        if (original !== undefined) process.env.GITHUB_ENV = original;
        else delete process.env.GITHUB_ENV;
      }
    });

    it('should read entries from GITHUB_ENV file', () => {
      const original = process.env.GITHUB_ENV;
      const envFile = path.join(tmpDir, 'github_env');
      fs.writeFileSync(envFile, 'GOROOT=/usr/local/go\nCARGO_HOME=/home/.cargo\n');
      process.env.GITHUB_ENV = envFile;

      try {
        const result = readGitHubEnvEntries();
        expect(result.GOROOT).toBe('/usr/local/go');
        expect(result.CARGO_HOME).toBe('/home/.cargo');
      } finally {
        if (original !== undefined) process.env.GITHUB_ENV = original;
        else delete process.env.GITHUB_ENV;
      }
    });

    it('should return empty object when file does not exist', () => {
      const original = process.env.GITHUB_ENV;
      process.env.GITHUB_ENV = '/nonexistent/path/github_env';

      try {
        const result = readGitHubEnvEntries();
        expect(result).toEqual({});
      } finally {
        if (original !== undefined) process.env.GITHUB_ENV = original;
        else delete process.env.GITHUB_ENV;
      }
    });
  });

  describe('mergeGitHubPathEntries', () => {
    it('should return current PATH when no github path entries', () => {
      const result = mergeGitHubPathEntries('/usr/bin:/usr/local/bin', []);
      expect(result).toBe('/usr/bin:/usr/local/bin');
    });

    it('should prepend github path entries to current PATH', () => {
      const result = mergeGitHubPathEntries(
        '/usr/bin:/usr/local/bin',
        ['/opt/hostedtoolcache/Ruby/3.3.10/x64/bin']
      );
      expect(result).toBe('/opt/hostedtoolcache/Ruby/3.3.10/x64/bin:/usr/bin:/usr/local/bin');
    });

    it('should not duplicate entries already in PATH', () => {
      const result = mergeGitHubPathEntries(
        '/opt/hostedtoolcache/Ruby/3.3.10/x64/bin:/usr/bin:/usr/local/bin',
        ['/opt/hostedtoolcache/Ruby/3.3.10/x64/bin']
      );
      expect(result).toBe('/opt/hostedtoolcache/Ruby/3.3.10/x64/bin:/usr/bin:/usr/local/bin');
    });

    it('should handle multiple new entries', () => {
      const result = mergeGitHubPathEntries(
        '/usr/bin',
        ['/opt/hostedtoolcache/Ruby/3.3.10/x64/bin', '/opt/dart-sdk/bin']
      );
      expect(result).toBe('/opt/hostedtoolcache/Ruby/3.3.10/x64/bin:/opt/dart-sdk/bin:/usr/bin');
    });

    it('should handle mix of new and existing entries', () => {
      const result = mergeGitHubPathEntries(
        '/opt/hostedtoolcache/Ruby/3.3.10/x64/bin:/usr/bin',
        ['/opt/hostedtoolcache/Ruby/3.3.10/x64/bin', '/opt/dart-sdk/bin']
      );
      expect(result).toBe('/opt/dart-sdk/bin:/opt/hostedtoolcache/Ruby/3.3.10/x64/bin:/usr/bin');
    });

    it('should handle empty current PATH', () => {
      const result = mergeGitHubPathEntries(
        '',
        ['/opt/hostedtoolcache/Ruby/3.3.10/x64/bin']
      );
      expect(result).toBe('/opt/hostedtoolcache/Ruby/3.3.10/x64/bin');
    });
  });

  describe('readEnvFile', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-readenvfile-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should parse KEY=VALUE pairs', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'FOO=bar\nBAZ=qux\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('should skip comment lines starting with #', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, '# comment\nFOO=bar\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
    });

    it('should skip blank lines', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, '\nFOO=bar\n\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
    });

    it('should allow empty values', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'FOO=\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: '' });
    });

    it('should allow values containing = signs', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'FOO=a=b=c\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'a=b=c' });
    });

    it('should ignore lines that do not match KEY=VALUE format', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'INVALID LINE\nFOO=bar\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
    });

    it('should reject keys starting with a digit', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, '123KEY=value\nFOO=bar\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
    });

    it('should reject keys containing hyphens', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, 'KEY-NAME=value\nFOO=bar\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
    });

    it('should handle lines with leading whitespace by trimming them', () => {
      const envFile = path.join(tmpDir, '.env');
      fs.writeFileSync(envFile, '  FOO=bar\n');
      expect(readEnvFile(envFile)).toEqual({ FOO: 'bar' });
    });

    it('should throw when file does not exist', () => {
      expect(() => readEnvFile(path.join(tmpDir, 'missing.env'))).toThrow();
    });
  });
});
