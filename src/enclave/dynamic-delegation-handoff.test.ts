import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveEnclavePaths } from './paths';
import {
  DELEGATION_CONTROL_ENDPOINT_PATH,
  isValidEnclaveDynamicDelegationCapability,
  parseEnclaveDynamicDelegationControlEndpoint,
  readStagedEnclaveDynamicDelegationHandoff,
  resolveEnclaveDynamicDelegationHandoff,
  stageEnclaveDynamicDelegationHandoff,
  takeEnclaveDynamicDelegationHandoff,
} from './dynamic-delegation-handoff';

const CAPABILITY = 'a'.repeat(64);

function endpoint(value: string): string {
  return `${value}${DELEGATION_CONTROL_ENDPOINT_PATH}`;
}

describe('dynamic delegation control endpoint validation', () => {
  it('accepts the exact endpoint gh-aw exports', () => {
    const parsed = parseEnclaveDynamicDelegationControlEndpoint(
      'http://127.0.0.1:8090/internal/awf-enclave-mcp-control/github-repository-delegation-v1',
    );
    expect(parsed).toMatchObject({
      host: '127.0.0.1',
      port: 8090,
      origin: 'http://127.0.0.1:8090',
      operationBasePath: '/internal/awf-enclave-mcp-control/',
    });
  });

  it('accepts the IPv6 loopback literal', () => {
    expect(parseEnclaveDynamicDelegationControlEndpoint(endpoint('http://[::1]:8090')))
      .toMatchObject({ host: '[::1]', port: 8090 });
  });

  it.each([
    ['an explicit default port', endpoint('http://127.0.0.1:80'), 80],
    ['an omitted default port', endpoint('http://127.0.0.1'), 80],
  ])('normalizes %s to port 80 instead of rejecting it', (_label, value, expected) => {
    expect(parseEnclaveDynamicDelegationControlEndpoint(value)).toMatchObject({ port: expected });
  });

  it.each([
    ['resolver-dependent localhost', endpoint('http://localhost:8090')],
    ['a resolver-dependent hostname', endpoint('http://mcpg.internal:8090')],
    ['a routable address', endpoint('http://10.0.0.5:8090')],
    ['a wildcard bind address', endpoint('http://0.0.0.0:8090')],
    ['an IPv6 wildcard', endpoint('http://[::]:8090')],
    ['https', endpoint('https://127.0.0.1:8090')],
    ['embedded credentials', 'http://user:pw@127.0.0.1:8090/internal/awf-enclave-mcp-control/github-repository-delegation-v1'],
    ['a query string', `${endpoint('http://127.0.0.1:8090')}?x=1`],
    ['a fragment', `${endpoint('http://127.0.0.1:8090')}#f`],
    ['a different control path', 'http://127.0.0.1:8090/internal/other/github-repository-delegation-v1'],
    ['a bare origin with no controller path', 'http://127.0.0.1:8090'],
    ['a data-plane MCP endpoint', 'http://127.0.0.1:8080/mcp/awf-enclave'],
    ['an out-of-range port', endpoint('http://127.0.0.1:99999')],
    ['a non-URL', 'not-a-url'],
    ['an empty value', ''],
  ])('rejects %s', (_label, value) => {
    expect(parseEnclaveDynamicDelegationControlEndpoint(value)).toBeUndefined();
  });

  it('rejects a missing value', () => {
    expect(parseEnclaveDynamicDelegationControlEndpoint(undefined)).toBeUndefined();
  });
});

describe('dynamic delegation capability validation', () => {
  it.each([
    ['the compiler-minted 256-bit hex value', CAPABILITY, true],
    ['an uppercase hex value', 'A'.repeat(64), false],
    ['a short value', 'a'.repeat(63), false],
    ['a long value', 'a'.repeat(65), false],
    ['a non-hex value', 'z'.repeat(64), false],
    ['an empty value', '', false],
  ])('classifies %s', (_label, value, expected) => {
    expect(isValidEnclaveDynamicDelegationCapability(value)).toBe(expected);
  });
});

describe('dynamic delegation handoff custody', () => {
  it('removes both values from the environment before anything can inherit them', () => {
    const env: NodeJS.ProcessEnv = {
      AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT: endpoint('http://127.0.0.1:8090'),
      AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY: CAPABILITY,
      UNRELATED: 'kept',
    };
    const taken = takeEnclaveDynamicDelegationHandoff(env);
    expect(taken.capability).toBe(CAPABILITY);
    expect(env.AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT).toBeUndefined();
    expect(env.AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY).toBeUndefined();
    expect(env.UNRELATED).toBe('kept');
  });

  it('also clears process.env when handed a detached environment', () => {
    process.env.AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY = CAPABILITY;
    try {
      takeEnclaveDynamicDelegationHandoff({});
      expect(process.env.AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY).toBeUndefined();
    } finally {
      delete process.env.AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY;
    }
  });

  it('fails closed on a partial handoff rather than degrading', () => {
    expect(resolveEnclaveDynamicDelegationHandoff({ capability: CAPABILITY }).handoff)
      .toBeUndefined();
    expect(
      resolveEnclaveDynamicDelegationHandoff({ endpoint: endpoint('http://127.0.0.1:8090') })
        .handoff,
    ).toBeUndefined();
  });

  it('never echoes the capability in an error message', () => {
    const resolution = resolveEnclaveDynamicDelegationHandoff({
      endpoint: endpoint('http://localhost:8090'),
      capability: CAPABILITY,
    });
    expect(resolution.handoff).toBeUndefined();
    expect(resolution.errors.join('\n')).not.toContain(CAPABILITY);
  });
});

describe('dynamic delegation handoff staging', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-delegation-handoff-'));
  });

  afterEach(() => {
    fs.rmSync(resolveEnclavePaths(workDir).root, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function stage(): ReturnType<typeof resolveEnclavePaths> {
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    const resolution = resolveEnclaveDynamicDelegationHandoff({
      endpoint: endpoint('http://127.0.0.1:8090'),
      capability: CAPABILITY,
    });
    stageEnclaveDynamicDelegationHandoff(paths, resolution.handoff!);
    return paths;
  }

  it('writes both values with exclusive 0600 permissions', () => {
    const paths = stage();
    for (const target of [paths.delegationEndpointPath, paths.delegationCapabilityPath]) {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
    expect(readStagedEnclaveDynamicDelegationHandoff(paths)).toMatchObject({
      capability: CAPABILITY,
    });
  });

  it('refuses a staged handoff that became group or world readable', () => {
    const paths = stage();
    fs.chmodSync(paths.delegationCapabilityPath, 0o644);
    expect(readStagedEnclaveDynamicDelegationHandoff(paths)).toBeUndefined();
  });

  it('refuses a staged endpoint that was tampered into a non-loopback host', () => {
    const paths = stage();
    fs.writeFileSync(paths.delegationEndpointPath, `${endpoint('http://10.1.2.3:8090')}\n`, {
      mode: 0o600,
    });
    expect(readStagedEnclaveDynamicDelegationHandoff(paths)).toBeUndefined();
  });

  it('keeps both custody files out of every broker-visible mount point', () => {
    const paths = stage();
    // The broker only ever mounts the run, control, audit, work, seed, and
    // delegation-channel paths. The custody files live directly in the private
    // root, which is never mounted as a whole.
    for (const target of [paths.delegationEndpointPath, paths.delegationCapabilityPath]) {
      expect(path.dirname(target)).toBe(paths.root);
      expect(target.startsWith(paths.delegationChannelDir)).toBe(false);
      expect(target.startsWith(paths.runDir)).toBe(false);
      expect(target.startsWith(paths.controlDir)).toBe(false);
      expect(target.startsWith(paths.auditDir)).toBe(false);
      expect(target.startsWith(paths.workDir)).toBe(false);
    }
  });
});
