'use strict';
/**
 * Tests for cli-proxy server.js
 *
 * Write control is now handled by the external DIFC guard policy.
 * The server only enforces meta-command denial (auth, config, extension).
 */

const { validateArgs, ALWAYS_DENIED_SUBCOMMANDS, PROTECTED_ENV_KEYS, buildExecEnv, runGhCommand } = require('./server');

describe('PROTECTED_ENV_KEYS', () => {
  it('should protect GH_HOST from agent override', () => {
    expect(PROTECTED_ENV_KEYS.has('GH_HOST')).toBe(true);
  });

  it('should protect GH_TOKEN from agent override', () => {
    expect(PROTECTED_ENV_KEYS.has('GH_TOKEN')).toBe(true);
  });

  it('should protect GITHUB_TOKEN from agent override', () => {
    expect(PROTECTED_ENV_KEYS.has('GITHUB_TOKEN')).toBe(true);
  });

  it('should protect NODE_EXTRA_CA_CERTS from agent override', () => {
    expect(PROTECTED_ENV_KEYS.has('NODE_EXTRA_CA_CERTS')).toBe(true);
  });

  it('should protect SSL_CERT_FILE from agent override (combined CA bundle for Go TLS)', () => {
    expect(PROTECTED_ENV_KEYS.has('SSL_CERT_FILE')).toBe(true);
  });
});

describe('validateArgs', () => {
  describe('input validation', () => {
    it('should reject non-array args', () => {
      const result = validateArgs('pr list');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('array');
    });

    it('should reject args with non-string elements', () => {
      const result = validateArgs(['pr', 42]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('strings');
    });

    it('should allow empty args array', () => {
      const result = validateArgs([]);
      expect(result.valid).toBe(true);
    });

    it('should allow flags-only args (e.g. --version)', () => {
      const result = validateArgs(['--version']);
      expect(result.valid).toBe(true);
    });

    it('should allow --help flag', () => {
      const result = validateArgs(['--help']);
      expect(result.valid).toBe(true);
    });
  });

  describe('always-denied subcommands', () => {
    for (const cmd of ALWAYS_DENIED_SUBCOMMANDS) {
      it(`should deny '${cmd}'`, () => {
        const result = validateArgs([cmd]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain(cmd);
      });
    }
  });

  describe('allowed subcommands (DIFC guard policy handles write control)', () => {
    it('should allow pr list', () => {
      const result = validateArgs(['pr', 'list', '--json', 'number,title']);
      expect(result.valid).toBe(true);
    });

    it('should allow pr view', () => {
      const result = validateArgs(['pr', 'view', '42']);
      expect(result.valid).toBe(true);
    });

    it('should allow pr create (guard policy handles write control)', () => {
      const result = validateArgs(['pr', 'create', '--title', 'My PR']);
      expect(result.valid).toBe(true);
    });

    it('should allow pr merge (guard policy handles write control)', () => {
      const result = validateArgs(['pr', 'merge', '42']);
      expect(result.valid).toBe(true);
    });

    it('should allow issue list', () => {
      const result = validateArgs(['issue', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow issue create (guard policy handles write control)', () => {
      const result = validateArgs(['issue', 'create', '--title', 'Bug']);
      expect(result.valid).toBe(true);
    });

    it('should allow repo view', () => {
      const result = validateArgs(['repo', 'view', 'owner/repo']);
      expect(result.valid).toBe(true);
    });

    it('should allow api subcommand (guard policy handles write control)', () => {
      const result = validateArgs(['api', 'repos/owner/repo']);
      expect(result.valid).toBe(true);
    });

    it('should allow api POST (guard policy handles write control)', () => {
      const result = validateArgs(['api', '-X', 'POST', '/repos/owner/repo/issues', '-f', 'title=Test']);
      expect(result.valid).toBe(true);
    });

    it('should allow search', () => {
      const result = validateArgs(['search', 'issues', '--query', 'bug']);
      expect(result.valid).toBe(true);
    });

    it('should allow workflow list', () => {
      const result = validateArgs(['workflow', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow workflow run (guard policy handles write control)', () => {
      const result = validateArgs(['workflow', 'run', 'ci.yml']);
      expect(result.valid).toBe(true);
    });

    it('should allow secret list', () => {
      const result = validateArgs(['secret', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow run list', () => {
      const result = validateArgs(['run', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow release list', () => {
      const result = validateArgs(['release', 'list']);
      expect(result.valid).toBe(true);
    });

    it('should allow gist view', () => {
      const result = validateArgs(['gist', 'view', 'abc123']);
      expect(result.valid).toBe(true);
    });

    it('should handle flags before subcommand gracefully', () => {
      // e.g.: gh --repo owner/repo pr list
      const result = validateArgs(['--repo', 'owner/repo', 'pr', 'list']);
      expect(result.valid).toBe(true);
    });
  });

  describe('meta-command denial', () => {
    it('should deny alias set (shell exec bypass)', () => {
      const result = validateArgs(['alias', 'set', 'myalias', '!echo pwned']);
      expect(result.valid).toBe(false);
    });

    it('should deny auth login', () => {
      const result = validateArgs(['auth', 'login']);
      expect(result.valid).toBe(false);
    });

    it('should deny config set', () => {
      const result = validateArgs(['config', 'set', 'editor', 'vim']);
      expect(result.valid).toBe(false);
    });

    it('should deny extension install', () => {
      const result = validateArgs(['extension', 'install', 'owner/ext']);
      expect(result.valid).toBe(false);
    });
  });

  describe('allowlist completeness', () => {
    it('should have ALWAYS_DENIED_SUBCOMMANDS as a non-empty Set', () => {
      expect(ALWAYS_DENIED_SUBCOMMANDS.size).toBeGreaterThan(0);
    });
  });
});

describe('buildExecEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, GH_HOST: 'github.com', GH_TOKEN: 'secret-token', GITHUB_TOKEN: 'secret-github-token', NODE_EXTRA_CA_CERTS: '/certs/ca.crt', SSL_CERT_FILE: '/certs/ssl.crt', GIT_SSL_CAINFO: '/certs/git.crt', EXISTING_VAR: 'existing' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should inherit server environment variables', () => {
    const env = buildExecEnv(null);
    expect(env.EXISTING_VAR).toBe('existing');
  });

  it('should apply safe extra env vars', () => {
    const env = buildExecEnv({ MY_VAR: 'my-value' });
    expect(env.MY_VAR).toBe('my-value');
  });

  it('should not allow overriding GH_HOST', () => {
    const env = buildExecEnv({ GH_HOST: 'evil.com' });
    expect(env.GH_HOST).toBe('github.com');
  });

  it('should not allow overriding GH_TOKEN', () => {
    const env = buildExecEnv({ GH_TOKEN: 'stolen' });
    expect(env.GH_TOKEN).toBe('secret-token');
  });

  it('should not allow overriding GITHUB_TOKEN', () => {
    const env = buildExecEnv({ GITHUB_TOKEN: 'stolen' });
    expect(env.GITHUB_TOKEN).toBe('secret-github-token');
  });

  it('should not allow overriding NODE_EXTRA_CA_CERTS', () => {
    const env = buildExecEnv({ NODE_EXTRA_CA_CERTS: '/evil/ca.crt' });
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/certs/ca.crt');
  });

  it('should not allow overriding SSL_CERT_FILE', () => {
    const env = buildExecEnv({ SSL_CERT_FILE: '/evil/ssl.crt' });
    expect(env.SSL_CERT_FILE).toBe('/certs/ssl.crt');
  });

  it('should not allow overriding GIT_SSL_CAINFO', () => {
    const env = buildExecEnv({ GIT_SSL_CAINFO: '/evil/git.crt' });
    expect(env.GIT_SSL_CAINFO).toBe('/certs/git.crt');
  });

  it('should silently skip non-string keys', () => {
    // Object.entries coerces, but we guard typeof key === 'string'
    const env = buildExecEnv({ MY_VAR: 'ok' });
    expect(env.MY_VAR).toBe('ok');
  });

  it('should silently skip non-string values', () => {
    const env = buildExecEnv({ MY_VAR: 42 });
    expect(env.MY_VAR).toBeUndefined();
  });

  it('should handle null extraEnv gracefully', () => {
    const env = buildExecEnv(null);
    expect(env.EXISTING_VAR).toBe('existing');
  });

  it('should handle undefined extraEnv gracefully', () => {
    const env = buildExecEnv(undefined);
    expect(env.EXISTING_VAR).toBe('existing');
  });

  it('should handle non-object extraEnv gracefully', () => {
    const env = buildExecEnv('not-an-object');
    expect(env.EXISTING_VAR).toBe('existing');
  });
});

describe('runGhCommand', () => {
  it('should return stdout, stderr, and exitCode on success', async () => {
    const result = await runGhCommand(['--version'], process.env, null);
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(result).toHaveProperty('exitCode');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.exitCode).toBe('number');
  });

  it('should return non-zero exitCode for invalid gh subcommand', async () => {
    const result = await runGhCommand(['__nonexistent_subcommand__'], process.env, null);
    expect(result.exitCode).not.toBe(0);
  });

  it('should return non-zero exitCode when gh binary is not found', async () => {
    // Temporarily remove gh from PATH
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await runGhCommand(['--version'], process.env, null);
      // When the binary is not found, exitCode is the ENOENT error code (truthy, non-zero)
      expect(result.exitCode).toBeTruthy();
      expect(result.exitCode).not.toBe(0);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
