'use strict';
/**
 * Tests for cli-proxy server.js
 *
 * Write control is handled by the external DIFC guard policy.
 * The server confines request shape, subprocess environment, and local helpers.
 */

const http = require('http');
const {
  validateArgs,
  validateEnclaveArgs,
  summarizeEnclaveArgs,
  extractInvocationCapability,
  ALWAYS_DENIED_SUBCOMMANDS,
  DENIED_COMMAND_PATHS,
  CHILD_ENV_KEYS,
  FORCED_CHILD_ENV,
  validateExecRequest,
  buildExecEnv,
} = require('./security');
const { runGhCommand } = require('./gh-runner');
const { requestHandler } = require('./server');

function postExec(payload) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      requestHandler(req, res).catch(reject);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const body = JSON.stringify(payload);
      const request = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/exec',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          server.close(() => resolve({
            statusCode: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }));
        });
      });
      request.on('error', reject);
      request.end(body);
    });
  });
}

describe('POST /exec request boundary', () => {
  it('rejects caller-controlled environment variables before executing gh', async () => {
    const response = await postExec({
      args: ['browse', '--repo', 'owner/repo'],
      env: { GH_BROWSER: '/bin/sh -c printenv GH_TOKEN' },
    });

    expect(response).toEqual({
      statusCode: 400,
      body: { error: 'Request contains an unsupported field' },
    });
  });
});

describe('validateExecRequest', () => {
  it('allows only args and optional stdin', () => {
    expect(validateExecRequest({ args: ['pr', 'list'], stdin: '' }, false)).toEqual({ valid: true });
  });

  it.each(['env', 'cwd', 'unexpected'])('rejects the unsupported %s field', (field) => {
    const result = validateExecRequest({ args: ['pr', 'list'], [field]: {} }, false);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('unsupported field');
  });

  it('rejects non-string stdin', () => {
    expect(validateExecRequest({ args: ['api'], stdin: {} }, false).valid).toBe(false);
  });

  it('continues to reject stdin in enclave mode', () => {
    expect(validateExecRequest({ args: ['api'], stdin: '' }, true).valid).toBe(false);
  });
});

describe('validateArgs', () => {
  describe('input validation', () => {
    it('should reject non-array args', () => {
      const result = validateArgs('pr list');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('array');
    });

    describe('issues-read-v1 enclave grammar', () => {
      it.each([
        [['api', '--method', 'GET', 'repos/octo/private/issues'], 'issues.list'],
        [['api', 'repos/octo/private/issues/42'], 'issues.get'],
        [['api', 'repos/octo/private/issues/42/comments?page=2&per_page=20'], 'issues.comments.list'],
        [['api', 'repos/octo/private/issues?labels=bug,enhancement'], 'issues.list'],
        [['api', 'repos/octo/private/issues?since=2026-01-02T03:04:05Z'], 'issues.list'],
      ])('allows a bounded REST issue read', (args, pathClass) => {
        expect(validateEnclaveArgs(args)).toEqual({ valid: true });
        expect(summarizeEnclaveArgs(args)).toEqual({
          profile: 'issues-read-v1',
          repository: 'octo/private',
          pathClass,
        });
      });

      it.each([
        ['issue', 'list'],
        ['api', 'graphql'],
        ['api', '--method', 'POST', 'repos/octo/private/issues'],
        ['api', 'https://api.github.com/repos/octo/private/issues'],
        ['api', 'repos/octo/private/pulls'],
        ['api', 'repos/octo/private/issues', '--field', 'title=write'],
        ['api', 'repos/octo/private/issues', '--paginate'],
        ['api', 'repos/octo/private/issues?per_page=101'],
        ['api', 'repos/octo/private/issues?per_page=20&per_page=30'],
        ['api', 'repos/octo/private/issues?redirect=https%3A%2F%2Fattacker.invalid'],
        ['api', 'repos/octo/private/issues/../pulls'],
        ['api', 'repos/../../issues'],
        ['api', 'repos/octo/../issues'],
        ['api', 'repos/octo/private/issues?labels=bad%escape'],
        ['api', 'repos/octo/private/issues?page=1?state=open'],
        ['api', 'repos/Octo/private/issues'],
      ])('rejects an out-of-profile command (%j)', (...args) => {
        expect(validateEnclaveArgs(args).valid).toBe(false);
      });

      it('rejects oversized argument vectors', () => {
        expect(validateEnclaveArgs(['api', 'repos/octo/private/issues', 'x'.repeat(4097)]).valid)
          .toBe(false);
        expect(validateEnclaveArgs(['api', ...Array(16).fill('--silent')]).valid).toBe(false);
      });

      it('accepts only one structurally canonical invocation bearer', () => {
        const payload = Buffer.from(JSON.stringify({
          v: 1,
          aud: 'gh-aw-enclave-github',
          run: 'run-123',
          inv: 'inv-456',
          repo: 'octo/private',
          profile: 'issues-read-v1',
          ops: ['issues.comments.list', 'issues.get', 'issues.list'],
          nbf: 1787594400,
          exp: 1787594520,
        })).toString('base64url');
        const token = `awf-egh1.${payload}.${'b'.repeat(43)}`;
        expect(extractInvocationCapability(`Bearer ${token}`)).toBe(token);
        expect(extractInvocationCapability(token)).toBeUndefined();
        expect(extractInvocationCapability(`Bearer ${token}=`)).toBeUndefined();
        expect(extractInvocationCapability(`Bearer ${token}, Bearer ${token}`)).toBeUndefined();
        const reordered = Buffer.from(JSON.stringify({
          aud: 'gh-aw-enclave-github',
          v: 1,
          run: 'run-123',
          inv: 'inv-456',
          repo: 'octo/private',
          profile: 'issues-read-v1',
          ops: ['issues.comments.list', 'issues.get', 'issues.list'],
          nbf: 1787594400,
          exp: 1787594520,
        })).toString('base64url');
        expect(extractInvocationCapability(
          `Bearer awf-egh1.${reordered}.${'b'.repeat(43)}`,
        )).toBeUndefined();
      });

      it('injects only the invocation capability in enclave mode', () => {
        const original = process.env;
        process.env = {
          ...original,
          AWF_CLI_PROXY_MODE: 'enclave',
          GH_TOKEN: 'ambient-gh',
          GITHUB_TOKEN: 'ambient-github',
          GH_ENTERPRISE_TOKEN: 'ambient-enterprise',
          GH_HOST: 'awf-enclave-github-proxy:18443',
        };
        try {
          const child = buildExecEnv('invocation-capability');
          expect(child.GH_ENTERPRISE_TOKEN).toBe('invocation-capability');
          expect(child.GH_TOKEN).toBeUndefined();
          expect(child.GITHUB_TOKEN).toBeUndefined();
          expect(child.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
          expect(child.GH_HOST).toBe('awf-enclave-github-proxy:18443');
          expect(child).not.toHaveProperty('MCP_GATEWAY_ENCLAVE_CAPABILITY_KEY');
        } finally {
          process.env = original;
        }
      });
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

    it('should deny browser helpers', () => {
      expect(validateArgs(['browse']).valid).toBe(false);
      expect(validateArgs(['pr', 'view', '--web']).valid).toBe(false);
      expect(validateArgs(['pr', 'view', '--browser=/bin/sh']).valid).toBe(false);
    });

    it('should deny alternate hosts', () => {
      expect(validateArgs(['api', '--hostname', 'attacker.invalid', '/user']).valid).toBe(false);
      expect(validateArgs(['api', '--hostname=attacker.invalid', '/user']).valid).toBe(false);
    });

    it('should deny API endpoint forms that can change URL authority', () => {
      expect(validateArgs(['api', '@attacker.invalid/proof']).valid).toBe(false);
      expect(validateArgs(['api', '//attacker.invalid/proof']).valid).toBe(false);
      expect(validateArgs(['api', 'https://attacker.invalid/proof']).valid).toBe(false);
      expect(validateArgs(['api', 'repos/owner/repo']).valid).toBe(true);
    });

    it.each([...DENIED_COMMAND_PATHS])('should deny shim-bypassing command %s', (commandPath) => {
      expect(validateArgs(commandPath.split(' ')).valid).toBe(false);
    });

    it('should permit file-valued fields only through stdin', () => {
      expect(validateArgs(['api', '-F', 'body=@-']).valid).toBe(true);
      expect(validateArgs(['api', '-F', 'body=@/proc/self/environ']).valid).toBe(false);
      expect(validateArgs(['pr', 'create', '--body-file', '-']).valid).toBe(true);
      expect(validateArgs(['pr', 'create', '--body-file', '/proc/self/environ']).valid).toBe(false);
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
    process.env = {
      ...originalEnv,
      GH_HOST: 'github.com',
      GH_TOKEN: 'secret-token',
      GITHUB_TOKEN: 'secret-github-token',
      NODE_EXTRA_CA_CERTS: '/certs/ca.crt',
      SSL_CERT_FILE: '/certs/ssl.crt',
      GIT_SSL_CAINFO: '/certs/git.crt',
      GH_BROWSER: '/bin/sh -c printenv GH_TOKEN',
      EXISTING_VAR: 'existing',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('copies only explicitly allowed server environment variables', () => {
    const env = buildExecEnv();
    expect(env.GH_HOST).toBe('github.com');
    expect(env.GH_TOKEN).toBe('secret-token');
    expect(env.GITHUB_TOKEN).toBe('secret-github-token');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/certs/ca.crt');
    expect(env.SSL_CERT_FILE).toBe('/certs/ssl.crt');
    expect(env.GIT_SSL_CAINFO).toBe('/certs/git.crt');
    expect(env.EXISTING_VAR).toBeUndefined();
    expect(CHILD_ENV_KEYS.has('EXISTING_VAR')).toBe(false);
  });

  it('forces noninteractive helper settings over ambient values', () => {
    const env = buildExecEnv();
    expect(env.GH_BROWSER).toBe('false');
    expect(env.BROWSER).toBe('false');
    expect(env.GH_EDITOR).toBe('false');
    expect(env.GH_PAGER).toBe('cat');
    expect(env.GH_PROMPT_DISABLED).toBe('1');
    expect(env).toEqual(expect.objectContaining(FORCED_CHILD_ENV));
  });
});

describe('runGhCommand', () => {
  // These tests spawn the real `gh` binary, so they are sensitive to runner
  // contention. Jest's 5s default is too tight under load; give them headroom.
  const REAL_GH_TIMEOUT_MS = 30000;

  it('should return stdout, stderr, and exitCode on success', async () => {
    const result = await runGhCommand(['--version'], process.env, null);
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
    expect(result).toHaveProperty('exitCode');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.exitCode).toBe('number');
  }, REAL_GH_TIMEOUT_MS);

  it('should return non-zero exitCode for invalid gh subcommand', async () => {
    const result = await runGhCommand(['__nonexistent_subcommand__'], process.env, null);
    expect(result.exitCode).not.toBe(0);
  }, REAL_GH_TIMEOUT_MS);

  it('should return non-zero exitCode when gh binary is not found', async () => {
    // Temporarily remove gh from PATH
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await runGhCommand(['--version'], process.env, null);
      expect(typeof result.exitCode).toBe('number');
      expect(result.exitCode).toBe(1);
    } finally {
      process.env.PATH = savedPath;
    }
  }, REAL_GH_TIMEOUT_MS);

  it('terminates an active child when the request is cancelled', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const resultPromise = runGhCommand(
      ['-e', 'setTimeout(() => {}, 30000)'],
      process.env,
      null,
      controller.signal,
      process.execPath,
    );
    setTimeout(() => controller.abort(), 25);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: '',
      stderr: 'Command cancelled',
      exitCode: 1,
      cancelled: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  }, REAL_GH_TIMEOUT_MS);
});
