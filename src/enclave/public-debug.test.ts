import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { assertCloudHypervisorEnclaveExportsIsolated, assertPrivateRootIsolated } from './mount-policy';
import {
  ENCLAVE_DEBUG_ARTIFACT_ROOT,
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
  it('does not check visibility or enable artifacts by default', async () => {
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
    await expect(verifyPublicEnclaveDebugRepositories(config(), request)).rejects.toThrow('network timeout');
    await expect(verifyPublicEnclaveDebugRepositories(config(), requester('x'.repeat(65537))))
      .rejects.toThrow(/bound/);
    request.mockResolvedValue(new Response('not json'));
    await expect(verifyPublicEnclaveDebugRepositories(config(), request)).rejects.toThrow();
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
