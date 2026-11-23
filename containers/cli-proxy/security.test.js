'use strict';

const security = require('./security');
const {
  validateArgs,
  validateExecRequest,
  validateEnclaveArgs,
  summarizeEnclaveArgs,
  extractInvocationCapability,
  capabilityAuditContext,
  buildExecEnv,
} = security;
const endpoint = 'repos/octo/private/issues';
const capabilityPayload = {
  v: 1,
  aud: 'gh-aw-enclave-github',
  run: 'run-123',
  inv: 'inv-456',
  repo: 'octo/private',
  profile: 'issues-read-v1',
  ops: ['issues.comments.list', 'issues.get', 'issues.list'],
  nbf: 1787594400,
  exp: 1787594520,
};

function capabilityToken(payloadText = JSON.stringify(capabilityPayload)) {
  return `awf-egh1.${Buffer.from(payloadText).toString('base64url')}.${'b'.repeat(43)}`;
}

function authorizationFor(token) {
  return ['Bearer', token].join(' ');
}

const originalEnv = process.env;
beforeEach(() => {
  process.env = {};
});
afterEach(() => {
  process.env = originalEnv;
});

describe('security facade', () => {
  it('preserves its public exports', () => {
    expect(Object.keys(security).sort()).toEqual([
      'ALWAYS_DENIED_SUBCOMMANDS', 'CHILD_ENV_KEYS', 'DENIED_COMMAND_PATHS',
      'FORCED_CHILD_ENV', 'buildExecEnv', 'capabilityAuditContext',
      'extractInvocationCapability', 'summarizeEnclaveArgs', 'validateArgs',
      'validateEnclaveArgs', 'validateExecRequest',
    ].sort());
  });

  it.each([
    [null, 'args must be an array'],
    [['api', 1], 'All args must be strings'],
    [Array(257).fill('--help'), 'Arguments exceed their bound'],
    [['x'.repeat(256 * 1024 + 1)], 'Arguments exceed their bound'],
    [['pr', 'view', '--web=false'], 'Helper-launching and host-selection flags are not permitted'],
    [['api', '--hostname', 'example.invalid'], 'Host-selection flags are not permitted'],
    [['co', '42'], "Command 'pr checkout' is not permitted"],
    [['ext', 'list'], "Subcommand 'extension' is not permitted"],
    [['api', '//example.invalid'], 'API endpoints must be relative paths'],
  ])('pins top-level denial for %j', (args, error) => {
    expect(validateArgs(args)).toEqual({ valid: false, error });
  });

  it('dispatches enclave mode to its separate grammar', () => {
    process.env.AWF_CLI_PROXY_MODE = 'enclave';
    expect(validateArgs(['api', endpoint])).toEqual({ valid: true });
    expect(validateArgs(['issue', 'list'])).toEqual({
      valid: false, error: 'issues-read-v1 permits only gh api',
    });
  });

  it.each([
    [null, false, 'Request body must be a JSON object'],
    [[], false, 'Request body must be a JSON object'],
    [{ args: [], env: {} }, false, 'Request contains an unsupported field'],
    [{ args: [], stdin: 1 }, false, 'stdin must be a base64 string or null'],
    [{ args: [], stdin: '' }, true, 'Enclave request contains an unsupported field'],
  ])('pins request-shape denial for %j', (body, enclaveMode, error) => {
    expect(validateExecRequest(body, enclaveMode)).toEqual({ valid: false, error });
  });

  it.each([{}, { args: [] }, { args: [], stdin: null }])('accepts request shape %j', (body) => {
    expect(validateExecRequest(body, true)).toEqual({ valid: true });
  });
});

describe('file-input policy through validateArgs', () => {
  it.each([
    ['gist', 'create', '-'],
    ['gist', 'new', '--', '-'],
    ['gist', 'create', '-pd', 'description', '-ffile.txt', '-'],
    ['gist', 'edit', 'abc123', '--add', 'file.txt', '-'],
    ['gist', 'edit', 'abc123', '--add='],
    ['release', '--repo=octo/private', 'new', 'v1', '-dF=-'],
    ['release', 'upload', '--clobber', 'v1'],
    ['release', 'create', 'v1', '--notes-file=-'],
    ['release', 'edit', 'v1', '-nFfile.txt'],
    ['issue', 'comment', '1', '--body', '-Ffile.txt'],
    ['api', '--input=-', endpoint],
    ['api', '-iFbody=@-', endpoint],
    ['api', '-F', 'body=literal=@file.txt', endpoint],
    ['api', '--header', '-Fbody=@file.txt', endpoint],
    ['api', '-f', 'body=@file.txt', endpoint],
    ['api', '--', '-Fbody=@file.txt'],
    ['workflow', 'run', 'ci.yml', '--field=body=@-'],
    ['workflow', 'run', 'ci.yml', '-Fbody=literal'],
  ].map((args) => [args]))('allows safe file-input argv %j', (args) => {
    expect(validateArgs(args)).toEqual({ valid: true });
  });

  it.each([
    [['gist', 'create', 'file.txt'], 'Positional file inputs are not permitted for gist create'],
    [['gist', 'new', '--', '--file'], 'Positional file inputs are not permitted for gist create'],
    [['gist', '--desc', 'description', 'create', 'file.txt'], 'Positional file inputs are not permitted for gist create'],
    [['gist', 'edit', 'abc123', '-afile.txt'], 'Positional file inputs are not permitted for gist edit'],
    [['gist', 'edit', 'abc123', '-', '-'], 'Positional file inputs are not permitted for gist edit'],
    [['gist', 'create', '--desc'], '--desc requires a value'],
    [['gist', 'create', '--unknown', '-'], "Flag '--unknown' is not permitted for gist create"],
    [['release', 'upload', 'v1', '-'], 'Positional file inputs are not permitted for release upload'],
    [['release', 'create', 'v1', 'file.txt#label'], 'Positional file inputs are not permitted for release create'],
    [['release', 'new', 'v1', '-dFfile.txt'], '-F file values permit only stdin'],
    [['release', 'create', 'v1', '--notes-file=file.txt'], '--notes-file permits only stdin'],
    [['release', 'create', 'v1', '--notes-file'], '--notes-file permits only stdin'],
    [['pr', 'create', '--body-file', 'file.txt'], '--body-file permits only stdin'],
    [['api', '--input=file.txt', endpoint], '--input permits only stdin'],
    [['api', '-iFbody=@file.txt', endpoint], '-F file values permit only stdin'],
    [['api', '--field=body=@file.txt', endpoint], '--field file values permit only stdin'],
    [['workflow', 'run', 'ci.yml', '--field', 'body=@file.txt'], '--field file values permit only stdin'],
    [['release', 'edit', 'v1', '--unknown', '-Ffile.txt'], "Flag '--unknown' is not permitted for release edit"],
  ])('pins file-input denial for %j', (args, error) => {
    expect(validateArgs(args)).toEqual({ valid: false, error });
  });

  it.each([
    'issue create', 'issue edit', 'issue comment',
    'pr create', 'pr edit', 'pr comment', 'pr review', 'pr merge', 'pr revert',
    'discussion create', 'discussion edit', 'discussion comment',
    'release create', 'release edit',
  ])('pins all short file-flag forms for %s', (command) => {
    for (const flags of [['-F', '-'], ['-F-'], ['-F=-']]) {
      expect(validateArgs([...command.split(' '), ...flags])).toEqual({ valid: true });
    }
    for (const flags of [['-F', 'file.txt'], ['-Ffile.txt'], ['-F=file.txt']]) {
      expect(validateArgs([...command.split(' '), ...flags])).toEqual({
        valid: false, error: '-F file values permit only stdin',
      });
    }
  });
});

describe('enclave policy', () => {
  it.each([
    [['api', endpoint], 'issues.list'],
    [['api', '--method=GET', `/${endpoint}/42`, '--include'], 'issues.get'],
    [['api', '-X', 'GET', `${endpoint}/42/comments?page=999&per_page=100`], 'issues.comments.list'],
    [['api', '--silent', '--jq', '.[]', endpoint], 'issues.list'],
    [['api', '-t', '{{.}}', `${endpoint}?labels=bug%2Cenhancement&state=all`], 'issues.list'],
  ])('allows and summarizes %j', (args, pathClass) => {
    expect(validateEnclaveArgs(args)).toEqual({ valid: true });
    expect(summarizeEnclaveArgs(args)).toEqual({
      profile: 'issues-read-v1', repository: 'octo/private', pathClass,
    });
  });

  it.each([
    [null, 'args must be an array of strings'],
    [['api', 1], 'args must be an array of strings'],
    [['api', ...Array(16).fill('--silent')], 'issues-read-v1 arguments exceed their bound'],
    [['api', 'x'.repeat(4097)], 'issues-read-v1 arguments exceed their bound'],
    [['issue', 'list'], 'issues-read-v1 permits only gh api'],
    [['api', '-X', 'POST', endpoint], 'issues-read-v1 permits only GET'],
    [['api', '--method=POST', endpoint], 'issues-read-v1 permits only GET'],
    [['api', '--method'], 'issues-read-v1 permits only GET'],
    [['api', endpoint, '--jq'], '--jq requires a bounded value'],
    [['api', endpoint, '-t', '--silent'], '-t requires a bounded value'],
    [['api', endpoint, '--paginate'], "flag '--paginate' is not permitted"],
    [['api', endpoint, endpoint], 'issues-read-v1 accepts exactly one endpoint'],
    [['api'], 'endpoint is outside issues-read-v1'],
    [['api', 'x'.repeat(513)], 'endpoint is outside issues-read-v1'],
  ])('pins enclave argument denial for %j', (args, error) => {
    expect(validateEnclaveArgs(args)).toEqual({ valid: false, error });
  });

  it.each([
    'graphql', 'https://api.github.com/repos/octo/private/issues',
    'repos/Octo/private/issues', 'repos/../../issues', 'repos/octo/../issues',
    `${endpoint}/0`, `${endpoint}/42/../pulls`, `${endpoint}/42/comments/1`,
    `${endpoint}?per_page=0`, `${endpoint}?per_page=101`,
    `${endpoint}?page=0`, `${endpoint}?page=1000`,
    `${endpoint}?state=unknown`, `${endpoint}?direction=up`, `${endpoint}?sort=title`,
    `${endpoint}?labels=`, `${endpoint}?labels=${'a'.repeat(257)}`,
    `${endpoint}?labels=bad%escape`, `${endpoint}?labels=%00`,
    `${endpoint}?labels=%7f`, `${endpoint}?page=1?state=open`,
    `${endpoint}?per_page=20&per_page=30`, `${endpoint}?unknown=value`,
  ])('pins endpoint and query denial for %s', (value) => {
    expect(validateEnclaveArgs(['api', value])).toEqual({
      valid: false, error: 'endpoint is outside issues-read-v1',
    });
  });

  it('pins inclusive argument and query bounds', () => {
    expect(validateEnclaveArgs([
      'api', endpoint, '--jq', 'x'.repeat(4096), ...Array(12).fill('--silent'),
    ])).toEqual({ valid: true });
    expect(validateEnclaveArgs(['api', `${endpoint}?labels=${'a'.repeat(256)}`]))
      .toEqual({ valid: true });
    expect(summarizeEnclaveArgs(['api', 'graphql'])).toEqual({
      profile: 'issues-read-v1', pathClass: 'invalid',
    });
  });
});

describe('invocation capability', () => {
  it('extracts a canonical bearer and its asserted audit context', () => {
    const token = capabilityToken();
    expect(extractInvocationCapability(authorizationFor(token))).toBe(token);
    expect(capabilityAuditContext(token)).toEqual({
      assertedRun: 'run-123', assertedInvocation: 'inv-456', assertedRepository: 'octo/private',
    });
    expect(capabilityAuditContext('invalid')).toEqual({});
  });

  it.each([
    { v: 2 }, { aud: 'other' }, { profile: 'other' },
    { ops: ['issues.list'] }, { run: 'Run-123' }, { inv: '' },
    { repo: 'octo' }, { nbf: -1 }, { exp: capabilityPayload.nbf },
    { exp: 1.5 }, { extra: true },
  ])('rejects noncanonical capability fields %j', (fields) => {
    const token = capabilityToken(JSON.stringify({ ...capabilityPayload, ...fields }));
    expect(extractInvocationCapability(authorizationFor(token))).toBeUndefined();
  });

  it.each([
    undefined, '', capabilityToken(), `bearer ${capabilityToken()}`,
    authorizationFor(`${capabilityToken()} extra`),
    authorizationFor(capabilityToken().slice(0, -1)),
    authorizationFor(capabilityToken(JSON.stringify(capabilityPayload, null, 2))),
    authorizationFor(capabilityToken('null')),
    authorizationFor(capabilityToken('{')),
  ])('rejects malformed authorization %#', (authorization) => {
    expect(extractInvocationCapability(authorization)).toBeUndefined();
  });
});

describe('child environment', () => {
  it('copies only allowed values and forces inert helpers', () => {
    process.env = { PATH: '/usr/bin', GH_HOST: 'github.com', NODE_OPTIONS: '--inspect', GH_EDITOR: 'vim' };
    expect(buildExecEnv()).toEqual({
      ...security.FORCED_CHILD_ENV, PATH: '/usr/bin', GH_HOST: 'github.com',
    });
  });

  it('replaces ambient credentials with only the enclave capability', () => {
    process.env = {
      AWF_CLI_PROXY_MODE: 'enclave', GH_HOST: 'private-alias',
      GH_TOKEN: 'dummy-gh', GITHUB_TOKEN: 'dummy-github',
      GH_ENTERPRISE_TOKEN: 'dummy-enterprise', GITHUB_ENTERPRISE_TOKEN: 'dummy-github-enterprise',
    };
    expect(() => buildExecEnv()).toThrow('missing enclave invocation capability');
    expect(buildExecEnv('invocation-capability')).toEqual({
      ...security.FORCED_CHILD_ENV, GH_HOST: 'private-alias', GH_ENTERPRISE_TOKEN: 'invocation-capability',
    });
  });
});
