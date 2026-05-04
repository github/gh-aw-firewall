import { subnetsOverlap, validateIdNotInSystemRange, getSafeHostUid, getSafeHostGid, getRealUserHome, extractGhHostFromServerUrl, readGitHubPathEntries, mergeGitHubPathEntries, readGitHubEnvEntries, parseGitHubEnvFile, readEnvFile, MIN_REGULAR_UID, ACT_PRESET_BASE_IMAGE, stripScheme, parseDifcProxyHost } from './docker-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions
const mockExecaFn = jest.fn();
const mockExecaSync = jest.fn();

// Mock execa module
jest.mock('execa', () => {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
});

describe('docker-manager utilities', () => {
  describe('subnetsOverlap', () => {

    it('should detect overlapping subnets with same CIDR', () => {
      expect(subnetsOverlap('172.30.0.0/24', '172.30.0.0/24')).toBe(true);
    });

    it('should detect non-overlapping subnets', () => {
      expect(subnetsOverlap('172.30.0.0/24', '172.31.0.0/24')).toBe(false);
      expect(subnetsOverlap('192.168.1.0/24', '192.168.2.0/24')).toBe(false);
    });

    it('should detect when smaller subnet is inside larger subnet', () => {
      expect(subnetsOverlap('172.16.0.0/16', '172.16.5.0/24')).toBe(true);
      expect(subnetsOverlap('172.16.5.0/24', '172.16.0.0/16')).toBe(true);
    });

    it('should detect partial overlap', () => {
      expect(subnetsOverlap('172.30.0.0/23', '172.30.1.0/24')).toBe(true);
    });

    it('should handle Docker default bridge network', () => {
      expect(subnetsOverlap('172.17.0.0/16', '172.17.5.0/24')).toBe(true);
      expect(subnetsOverlap('172.17.0.0/16', '172.18.0.0/16')).toBe(false);
    });

    it('should handle /32 (single host) networks', () => {
      expect(subnetsOverlap('192.168.1.1/32', '192.168.1.1/32')).toBe(true);
      expect(subnetsOverlap('192.168.1.1/32', '192.168.1.2/32')).toBe(false);
    });
  });

  describe('ACT_PRESET_BASE_IMAGE', () => {
    it('should be a valid catthehacker act image', () => {
      expect(ACT_PRESET_BASE_IMAGE).toBe('ghcr.io/catthehacker/ubuntu:act-24.04');
    });

    it('should match expected pattern for catthehacker images', () => {
      expect(ACT_PRESET_BASE_IMAGE).toMatch(/^ghcr\.io\/catthehacker\/ubuntu:act-\d+\.\d+$/);
    });
  });

  describe('validateIdNotInSystemRange', () => {
    it('should return 1000 for system UIDs (0-999)', () => {
      expect(validateIdNotInSystemRange(0)).toBe('1000');
      expect(validateIdNotInSystemRange(1)).toBe('1000');
      expect(validateIdNotInSystemRange(13)).toBe('1000'); // proxy user
      expect(validateIdNotInSystemRange(999)).toBe('1000');
    });

    it('should return the UID as-is for regular users (>= 1000)', () => {
      expect(validateIdNotInSystemRange(1000)).toBe('1000');
      expect(validateIdNotInSystemRange(1001)).toBe('1001');
      expect(validateIdNotInSystemRange(65534)).toBe('65534'); // nobody user on some systems
    });
  });

  describe('getSafeHostUid', () => {
    const originalGetuid = process.getuid;
    const originalSudoUid = process.env.SUDO_UID;

    afterEach(() => {
      process.getuid = originalGetuid;
      if (originalSudoUid !== undefined) {
        process.env.SUDO_UID = originalSudoUid;
      } else {
        delete process.env.SUDO_UID;
      }
    });

    it('should return 1000 when SUDO_UID is a system UID', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '13'; // proxy user
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return SUDO_UID when it is a regular user UID', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '1001';
      expect(getSafeHostUid()).toBe('1001');
    });

    it('should return 1000 when SUDO_UID is 0', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = '0';
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return 1000 when running as root without SUDO_UID', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return 1000 for non-root system UID', () => {
      process.getuid = () => 13; // proxy user
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1000');
    });

    it('should return the UID when running as regular user', () => {
      process.getuid = () => 1001;
      delete process.env.SUDO_UID;
      expect(getSafeHostUid()).toBe('1001');
    });

    it('should return 1000 when SUDO_UID is not a valid number', () => {
      process.getuid = () => 0; // Running as root
      process.env.SUDO_UID = 'not-a-number';
      expect(getSafeHostUid()).toBe('1000');
    });
  });

  describe('getSafeHostGid', () => {
    const originalGetgid = process.getgid;
    const originalSudoGid = process.env.SUDO_GID;

    afterEach(() => {
      process.getgid = originalGetgid;
      if (originalSudoGid !== undefined) {
        process.env.SUDO_GID = originalSudoGid;
      } else {
        delete process.env.SUDO_GID;
      }
    });

    it('should return 1000 when SUDO_GID is a system GID', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '13'; // proxy group
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return SUDO_GID when it is a regular user GID', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '1001';
      expect(getSafeHostGid()).toBe('1001');
    });

    it('should return 1000 when SUDO_GID is 0', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = '0';
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return 1000 when running as root without SUDO_GID', () => {
      process.getgid = () => 0;
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return 1000 for non-root system GID', () => {
      process.getgid = () => 13; // proxy group
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1000');
    });

    it('should return the GID when running as regular user', () => {
      process.getgid = () => 1001;
      delete process.env.SUDO_GID;
      expect(getSafeHostGid()).toBe('1001');
    });

    it('should return 1000 when SUDO_GID is not a valid number', () => {
      process.getgid = () => 0; // Running as root
      process.env.SUDO_GID = 'not-a-number';
      expect(getSafeHostGid()).toBe('1000');
    });
  });

  describe('getRealUserHome', () => {
    const originalGetuid = process.getuid;
    const originalSudoUser = process.env.SUDO_USER;
    const originalHome = process.env.HOME;

    afterEach(() => {
      process.getuid = originalGetuid;
      process.env.SUDO_USER = originalSudoUser;
      process.env.HOME = originalHome;
      jest.restoreAllMocks();
    });

    it('should return HOME when running as regular user', () => {
      process.getuid = () => 1001;
      process.env.HOME = '/home/testuser';
      expect(getRealUserHome()).toBe('/home/testuser');
    });

    it('should return /root as fallback when HOME is not set and running as root', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_USER;
      delete process.env.HOME;
      expect(getRealUserHome()).toBe('/root');
    });

    it('should use HOME as fallback when running as root without SUDO_USER', () => {
      process.getuid = () => 0;
      delete process.env.SUDO_USER;
      process.env.HOME = '/root';
      expect(getRealUserHome()).toBe('/root');
    });

    it('should look up user home from /etc/passwd when running as root with SUDO_USER (using real root user)', () => {
      // Test with actual /etc/passwd by using 'root' user which always exists
      process.getuid = () => 0;
      process.env.SUDO_USER = 'root';
      process.env.HOME = '/some/other/path';

      // Should find root's home directory from /etc/passwd
      expect(getRealUserHome()).toBe('/root');
    });

    it('should fall back to HOME when SUDO_USER not found in /etc/passwd', () => {
      process.getuid = () => 0;
      process.env.SUDO_USER = 'nonexistent_user_12345';
      process.env.HOME = '/fallback/home';

      // User doesn't exist in /etc/passwd, should fall back to HOME
      expect(getRealUserHome()).toBe('/fallback/home');
    });

    it('should handle undefined getuid gracefully (using real /etc/passwd)', () => {
      // Simulate environment where process.getuid is undefined (e.g., Windows)
      process.getuid = undefined as any;
      process.env.SUDO_USER = 'root';
      process.env.HOME = '/custom/home';

      // With getuid undefined, uid is undefined (falsy), so it attempts passwd lookup
      // Should find root's home directory from /etc/passwd
      expect(getRealUserHome()).toBe('/root');
    });
  });

  describe('extractGhHostFromServerUrl', () => {
    it('should return null for undefined GITHUB_SERVER_URL', () => {
      expect(extractGhHostFromServerUrl(undefined)).toBeNull();
    });

    it('should return null for empty string GITHUB_SERVER_URL', () => {
      expect(extractGhHostFromServerUrl('')).toBeNull();
    });

    it('should return null for github.com (public GitHub)', () => {
      expect(extractGhHostFromServerUrl('https://github.com')).toBeNull();
    });

    it('should extract hostname for GHEC instance (*.ghe.com)', () => {
      expect(extractGhHostFromServerUrl('https://acme.ghe.com')).toBe('acme.ghe.com');
    });

    it('should extract hostname for GHES instance', () => {
      expect(extractGhHostFromServerUrl('https://github.company.com')).toBe('github.company.com');
    });

    it('should extract hostname for GHES instance with custom port', () => {
      expect(extractGhHostFromServerUrl('https://github.internal:8443')).toBe('github.internal');
    });

    it('should handle GITHUB_SERVER_URL without trailing slash', () => {
      expect(extractGhHostFromServerUrl('https://github.enterprise.local')).toBe('github.enterprise.local');
    });

    it('should handle GITHUB_SERVER_URL with trailing slash', () => {
      expect(extractGhHostFromServerUrl('https://github.enterprise.local/')).toBe('github.enterprise.local');
    });

    it('should return null for invalid URL', () => {
      expect(extractGhHostFromServerUrl('not-a-valid-url')).toBeNull();
    });

    it('should return null for malformed URL', () => {
      expect(extractGhHostFromServerUrl('http://')).toBeNull();
    });
  });

  describe('MIN_REGULAR_UID constant', () => {
    it('should be 1000 (standard Linux regular user UID threshold)', () => {
      expect(MIN_REGULAR_UID).toBe(1000);
    });
  });

  describe('stripScheme', () => {
    it('should strip https:// prefix', () => {
      expect(stripScheme('https://my-gateway.example.com')).toBe('my-gateway.example.com');
    });

    it('should strip http:// prefix', () => {
      expect(stripScheme('http://my-gateway.example.com')).toBe('my-gateway.example.com');
    });

    it('should preserve bare hostname', () => {
      expect(stripScheme('api.openai.com')).toBe('api.openai.com');
    });

    it('should normalize URL with path to hostname only', () => {
      expect(stripScheme('https://my-gateway.example.com/some-path')).toBe('my-gateway.example.com');
    });

    it('should not strip scheme-like substrings in the middle', () => {
      expect(stripScheme('api.https.example.com')).toBe('api.https.example.com');
    });
  });

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

  describe('parseGitHubEnvFile', () => {
    it('should parse simple KEY=VALUE entries', () => {
      const result = parseGitHubEnvFile('GOROOT=/usr/local/go\nJAVA_HOME=/usr/lib/jvm/java-17\n');
      expect(result).toEqual({
        GOROOT: '/usr/local/go',
        JAVA_HOME: '/usr/lib/jvm/java-17',
      });
    });

    it('should handle values containing = characters', () => {
      const result = parseGitHubEnvFile('MY_VAR=key=value=extra\n');
      expect(result).toEqual({ MY_VAR: 'key=value=extra' });
    });

    it('should handle heredoc multiline values', () => {
      const content = 'MULTI_LINE<<EOF\nline1\nline2\nline3\nEOF\n';
      const result = parseGitHubEnvFile(content);
      expect(result).toEqual({ MULTI_LINE: 'line1\nline2\nline3' });
    });

    it('should handle CRLF line endings', () => {
      const result = parseGitHubEnvFile('GOROOT=/usr/local/go\r\nJAVA_HOME=/usr/lib/jvm\r\n');
      expect(result).toEqual({
        GOROOT: '/usr/local/go',
        JAVA_HOME: '/usr/lib/jvm',
      });
    });

    it('should handle mixed simple and heredoc entries', () => {
      const content = 'SIMPLE=value\nHEREDOC<<END\nmulti\nline\nEND\nANOTHER=val2\n';
      const result = parseGitHubEnvFile(content);
      expect(result).toEqual({
        SIMPLE: 'value',
        HEREDOC: 'multi\nline',
        ANOTHER: 'val2',
      });
    });

    it('should skip empty lines', () => {
      const result = parseGitHubEnvFile('\n\nGOROOT=/go\n\n');
      expect(result).toEqual({ GOROOT: '/go' });
    });

    it('should return empty object for empty content', () => {
      expect(parseGitHubEnvFile('')).toEqual({});
    });

    it('should handle unterminated heredoc gracefully', () => {
      const content = 'BROKEN<<EOF\nline1\nline2';
      const result = parseGitHubEnvFile(content);
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

  describe('parseDifcProxyHost', () => {
    it('should return default host and port for empty string', () => {
      expect(parseDifcProxyHost('')).toEqual({ host: 'host.docker.internal', port: '18443' });
    });

    it('should return default host and port for whitespace-only string', () => {
      expect(parseDifcProxyHost('   ')).toEqual({ host: 'host.docker.internal', port: '18443' });
    });

    it('should parse bare host:port', () => {
      expect(parseDifcProxyHost('my-gateway.internal:8443')).toEqual({ host: 'my-gateway.internal', port: '8443' });
    });

    it('should parse host with default port when no port given', () => {
      expect(parseDifcProxyHost('my-gateway.internal')).toEqual({ host: 'my-gateway.internal', port: '18443' });
    });

    it('should strip scheme prefix and parse host:port', () => {
      expect(parseDifcProxyHost('tcp://my-gateway.internal:9000')).toEqual({ host: 'my-gateway.internal', port: '9000' });
    });

    it('should parse https scheme with host:port', () => {
      expect(parseDifcProxyHost('https://proxy.internal:443')).toEqual({ host: 'proxy.internal', port: '443' });
    });

    it('should parse IPv6 bracketed notation', () => {
      expect(parseDifcProxyHost('[::1]:18443')).toEqual({ host: '::1', port: '18443' });
    });

    it('should throw for invalid host:port format', () => {
      expect(() => parseDifcProxyHost('not a valid:::host')).toThrow(/Invalid --difc-proxy-host/);
    });

    it('should throw for port out of range (too high)', () => {
      // Port 99999 causes URL parsing to fail (WHATWG URL spec: max port is 65535)
      expect(() => parseDifcProxyHost('host.internal:99999')).toThrow(/Invalid --difc-proxy-host/);
    });

    it('should throw for port 0', () => {
      // Port 0 parses as valid URL but fails the portNum < 1 check
      expect(() => parseDifcProxyHost('host.internal:0')).toThrow(/Invalid --difc-proxy-host port: 0/);
    });

    it('should parse port 1 (minimum valid port)', () => {
      expect(parseDifcProxyHost('host.internal:1')).toEqual({ host: 'host.internal', port: '1' });
    });

    it('should parse port 65535 (maximum valid port)', () => {
      expect(parseDifcProxyHost('host.internal:65535')).toEqual({ host: 'host.internal', port: '65535' });
    });
  });

});
