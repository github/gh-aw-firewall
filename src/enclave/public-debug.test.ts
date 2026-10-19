import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { assertCloudHypervisorEnclaveExportsIsolated, assertPrivateRootIsolated } from './mount-policy';
import {
  ENCLAVE_DEBUG_ARTIFACT_ROOT,
  resolvePublicEnclaveDebugConfig,
  validatePublicEnclaveDebug,
  verifyPublicEnclaveDebugRepositories,
} from './public-debug';

function config(): WrapperConfig {
  return {
    workDir: '/tmp/awf-public-debug',
    cloudHypervisor: { previewEnabled: true, enclaveDebugPublic: true },
    enclaves: normalizeEnclavesConfig([{
      script: {}, runtime: 'cloud-hypervisor',
      repos: [{ repo: 'octo/fixture', sensitivity: 'public' }],
    }]),
  } as WrapperConfig;
}

function requester(metadata: unknown, status = 200): jest.MockedFunction<typeof fetch> {
  return jest.fn().mockResolvedValue(new Response(JSON.stringify(metadata), { status }));
}

describe('host-only public enclave debug admission', () => {
  it('defaults eligible public-only configurations to retention without mutating caller state', () => {
    const c = config();
    delete c.cloudHypervisor!.enclaveDebugPublic;
    const resolved = resolvePublicEnclaveDebugConfig(c);
    expect(resolved.cloudHypervisor!.enclaveDebugPublic).toBe(true);
    expect(c.cloudHypervisor!.enclaveDebugPublic).toBeUndefined();
    c.cloudHypervisor!.enclaveDebugPublic = false;
    expect(resolvePublicEnclaveDebugConfig(c)).toBe(c);
    expect(c.cloudHypervisor!.enclaveDebugPublic).toBe(false);
  });

  it('leaves visibility verification to the lifecycle after default resolution', async () => {
    const c = config();
    delete c.cloudHypervisor!.enclaveDebugPublic;
    const request = requester({});
    expect(validatePublicEnclaveDebug(c)).toEqual([]);
    await verifyPublicEnclaveDebugRepositories(c, request);
    expect(request).not.toHaveBeenCalled();
  });

  it('requires unauthenticated, non-redirecting positive visibility verification', async () => {
    const request = requester({ full_name: 'Octo/Fixture', private: false, visibility: 'public' });
    await verifyPublicEnclaveDebugRepositories(config(), request);
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/octo/fixture', {
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'awf-public-enclave-debug' },
    });
  });

  it.each([
    { full_name: 'octo/fixture', private: true, visibility: 'private' },
    { full_name: 'octo/fixture', private: false, visibility: 'internal' },
    { full_name: 'octo/other', private: false, visibility: 'public' },
    { private: false },
    {},
    null,
  ])('rejects unverified or non-public metadata %j', async (metadata) => {
    await expect(verifyPublicEnclaveDebugRepositories(config(), requester(metadata))).rejects.toThrow(/public/i);
  });

  it('rejects unavailable, malformed and oversized visibility evidence', async () => {
    await expect(verifyPublicEnclaveDebugRepositories(config(), requester({}, 404))).rejects.toThrow(/verified/);
    const request: jest.MockedFunction<typeof fetch> = jest.fn().mockRejectedValue(new Error('network timeout'));
    await expect(verifyPublicEnclaveDebugRepositories(config(), request)).rejects.toThrow('reason=request-failed');
    await expect(verifyPublicEnclaveDebugRepositories(config(), requester('x'.repeat(65537))))
      .rejects.toThrow(/bound/);
    request.mockResolvedValue(new Response('not json'));
    await expect(verifyPublicEnclaveDebugRepositories(config(), request)).rejects.toThrow();
  });

  it.each([301, 302, 401, 403, 404, 429, 503])('reports HTTP %s without exposing response contents or headers', async (status) => {
    const request = jest.fn().mockResolvedValue(new Response('PRIVATE_SENTINEL', {
      status, headers: { 'x-private-header': 'PRIVATE_SENTINEL' },
    }));
    await expect(verifyPublicEnclaveDebugRepositories(config(), request))
      .rejects.toThrow(`reason=http-status; status=${status}`);
    await expect(verifyPublicEnclaveDebugRepositories(config(), request))
      .rejects.not.toThrow('PRIVATE_SENTINEL');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new DOMException('PRIVATE_SENTINEL', 'TimeoutError'), 'reason=timeout'],
    [Object.assign(new TypeError('PRIVATE_SENTINEL'), { cause: { code: 'ENOTFOUND' } }), 'code=ENOTFOUND'],
    [Object.assign(new TypeError('PRIVATE_SENTINEL'), { cause: { code: 'CERT_HAS_EXPIRED' } }), 'code=CERT_HAS_EXPIRED'],
    [Object.assign(new TypeError('PRIVATE_SENTINEL'), { cause: { code: 'PRIVATE_SENTINEL' } }), 'code=unknown'],
  ])('reports only allowlisted transport evidence for %p', async (error, expected) => {
    const request = jest.fn().mockRejectedValue(error);
    let failure: unknown;
    try {
      await verifyPublicEnclaveDebugRepositories(config(), request);
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(expected);
    expect(String(failure)).not.toContain('PRIVATE_SENTINEL');
    expect(failure).not.toHaveProperty('cause');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [() => new Response(null), 'missing-body'],
    [() => new Response('PRIVATE_SENTINEL'), 'invalid-json'],
    [() => new Response(JSON.stringify({ private: true })), 'unverified-metadata'],
    [() => new Response('x'.repeat(65537)), 'metadata-bound'],
    [() => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('PRIVATE_SENTINEL')); },
    })), 'body-read'],
  ])('classifies failed metadata evidence as %s', async (response, reason) => {
    const request = jest.fn().mockResolvedValue(response());
    await expect(verifyPublicEnclaveDebugRepositories(config(), request)).rejects.toThrow(`reason=${reason}`);
  });

  it('allows exactly 64 KiB and keeps the five-second request deadline', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const metadata = JSON.stringify({ full_name: 'octo/fixture', private: false, visibility: 'public' });
    const request = jest.fn().mockResolvedValue(new Response(metadata.padEnd(64 * 1024, ' ')));
    try {
      await verifyPublicEnclaveDebugRepositories(config(), request);
      expect(timeout).toHaveBeenCalledWith(5000);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    ['private sensitivity', (c: WrapperConfig) => { c.enclaves!.privateRepos[0].sensitivity = 'internal'; }],
    ['trusted sensitivity', (c: WrapperConfig) => { c.enclaves!.privateRepos[0].sensitivity = 'trusted'; }],
    ['mixed public/private', (c: WrapperConfig) => {
      c.enclaves!.privateRepos.push({ repo: 'octo/private', sensitivity: 'confidential' });
    }],
    ['no catalog', (c: WrapperConfig) => { c.enclaves!.privateRepos = []; }],
    ['no enclaves', (c: WrapperConfig) => { delete c.enclaves; }],
    ['dynamic', (c: WrapperConfig) => { Object.assign(c.enclaves!.executors.agent, { dynamic: {} }); }],
    ['other runtime', (c: WrapperConfig) => { c.enclaves!.executors.script.runtime = 'docker'; }],
    ['custom image', (c: WrapperConfig) => { c.enclaves!.executors.script.image = 'custom'; }],
    ['unattested', (c: WrapperConfig) => { c.cloudHypervisor!.developmentAllowUnattestedArtifacts = true; }],
    ['legacy digests', (c: WrapperConfig) => { c.cloudHypervisor!.sha256 = {}; }],
    ['preview disabled', (c: WrapperConfig) => { c.cloudHypervisor!.previewEnabled = false; }],
    ['invalid slug', (c: WrapperConfig) => { c.enclaves!.privateRepos[0].repo = '../private'; }],
  ] as const)('rejects %s before making any visibility request', async (_label, mutate) => {
    const c = config();
    mutate(c);
    const request = requester({});
    expect(validatePublicEnclaveDebug(c)).not.toEqual([]);
    await expect(verifyPublicEnclaveDebugRepositories(c, request)).rejects.toThrow(/public-only/);
    expect(request).not.toHaveBeenCalled();
    if (c.cloudHypervisor) delete c.cloudHypervisor.enclaveDebugPublic;
    expect(resolvePublicEnclaveDebugConfig(c)).toBe(c);
  });

  it('rejects primary-agent mounts and exports overlapping protected debug artifacts', () => {
    const c = config();
    c.volumeMounts = [`${ENCLAVE_DEBUG_ARTIFACT_ROOT}:/debug:ro`];
    expect(() => assertPrivateRootIsolated(c, {
      root: ENCLAVE_DEBUG_ARTIFACT_ROOT, ingressRoot: '/var/tmp/control',
    }, {}, process.cwd())).toThrow(/overlaps/);
    expect(() => assertCloudHypervisorEnclaveExportsIsolated(c, [{
      tag: 'debug', source: ENCLAVE_DEBUG_ARTIFACT_ROOT, target: '/debug', mode: 'ro',
    }])).toThrow(/overlaps/);
  });
});
