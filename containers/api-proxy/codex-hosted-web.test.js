'use strict';

const {
  parseCodexHostedWebPolicy,
  enforceResponses,
  enforceStandalone,
  makeCodexHostedWebTransform,
} = require('./codex-hosted-web');

const allow = { enabled: true, mode: 'allow', domains: ['docs.github.com'], maxUses: 5 };
const block = { enabled: true, mode: 'block', domains: ['evil.example'] };

describe('Codex hosted-web policy', () => {
  it('validates serialized policy at startup', () => {
    expect(() => parseCodexHostedWebPolicy('{"enabled":true}'))
      .toThrow(/AWF_CODEX_HOSTED_WEB_POLICY/);
    expect(parseCodexHostedWebPolicy('{"enabled":false}'))
      .toEqual({ enabled: false, mode: null, domains: [] });
  });

  it('leaves Responses requests without hosted tools unchanged', () => {
    expect(enforceResponses({ model: 'gpt-5', tools: [{ type: 'function' }] }, allow)).toBeNull();
  });

  it('injects/intersects filters and clamps max_uses on every Responses tool', () => {
    const result = enforceResponses({
      tools: [
        { type: 'web_search', filters: { allowed_domains: ['github.com'] }, max_uses: 9 },
        { type: 'web_search_2025_08_26' },
      ],
    }, allow);
    expect(result.tools).toEqual([
      {
        type: 'web_search',
        filters: { allowed_domains: ['docs.github.com'] },
        max_uses: 5,
      },
      {
        type: 'web_search_2025_08_26',
        filters: { allowed_domains: ['docs.github.com'] },
        max_uses: 5,
      },
    ]);
  });

  it('combines cross-mode filters rather than discarding either restriction', () => {
    expect(enforceResponses({
      tools: [{
        type: 'web_search',
        filters: {
          allowed_domains: ['docs.example.com'],
          blocked_domains: ['ads.example'],
        },
      }],
    }, { enabled: true, mode: 'allow', domains: ['example.com'] }).tools[0].filters)
      .toEqual({
        allowed_domains: ['docs.example.com'],
        blocked_domains: ['ads.example'],
      });

    expect(enforceResponses({
      tools: [{ type: 'web_search', filters: { allowed_domains: ['safe.example'] } }],
    }, block).tools[0].filters).toEqual({
      allowed_domains: ['safe.example'],
      blocked_domains: ['evil.example'],
    });
  });

  it.each([
    [{ enabled: false, mode: null, domains: [] }, 'codex_hosted_web_disabled'],
    [allow, 'codex_hosted_web_empty_intersection'],
  ])('rejects disabled access and empty intersections', (policy, code) => {
    const body = {
      tools: [{
        type: 'web_search',
        filters: policy.enabled ? { allowed_domains: ['evil.example'] } : undefined,
      }],
    };
    expect(() => enforceResponses(body, policy)).toThrow(expect.objectContaining({ code }));
  });

  it('injects standalone filters and narrows each query independently', () => {
    const result = enforceStandalone({
      settings: { external_web_access: 'indexed' },
      commands: {
        search_query: [
          { q: 'one', domains: ['github.com'] },
          { q: 'two', domains: ['docs.github.com'] },
        ],
      },
    }, { ...allow, maxUses: undefined });
    expect(result.settings.filters).toEqual({ allowed_domains: ['docs.github.com'] });
    expect(result.commands.search_query.map(query => query.domains))
      .toEqual([['docs.github.com'], ['docs.github.com']]);
  });

  it('unions standalone blocklists and prevents query scopes from removing blocks', () => {
    const result = enforceStandalone({
      settings: { filters: { blocked_domains: ['ads.example'] } },
      commands: { search_query: [{ q: 'safe', domains: ['safe.example'] }] },
    }, block);
    expect(result.settings.filters.blocked_domains).toEqual(['evil.example', 'ads.example']);
    expect(result.commands.search_query[0].domains).toEqual(['safe.example']);
    expect(() => enforceStandalone({
      commands: { search_query: [{ q: 'bad', domains: ['evil.example'] }] },
    }, block)).toThrow(expect.objectContaining({ code: 'codex_hosted_web_empty_query_scope' }));
  });

  it.each(['open', 'find', 'screenshot'])('checks literal URLs in %s commands', command => {
    expect(() => enforceStandalone({
      commands: { [command]: [{ ref_id: 'https://evil.example/private' }] },
    }, { ...allow, maxUses: undefined }))
      .toThrow(expect.objectContaining({ code: 'codex_hosted_web_url_disallowed' }));
  });

  it('allows non-URL reference IDs and rejects unknown command shapes', () => {
    expect(enforceStandalone({
      commands: { open: [{ ref_id: 'turn0search0' }] },
    }, { ...allow, maxUses: undefined }).commands.open[0].ref_id).toBe('turn0search0');
    expect(() => enforceStandalone({
      commands: { future_fetch: [{}] },
    }, { ...allow, maxUses: undefined }))
      .toThrow(expect.objectContaining({ code: 'codex_hosted_web_command_unrecognized' }));
  });

  it('rejects unsupported access modes and unsupported standalone maxUses', () => {
    expect(() => enforceStandalone({
      settings: { external_web_access: 'future' },
    }, { ...allow, maxUses: undefined }))
      .toThrow(expect.objectContaining({ code: 'codex_hosted_web_access_invalid' }));
    expect(() => enforceStandalone({}, allow))
      .toThrow(expect.objectContaining({ code: 'codex_hosted_web_max_uses_unsupported' }));
  });

  it('uses the request path to select the standalone body shape', () => {
    const transform = makeCodexHostedWebTransform({ ...allow, maxUses: undefined });
    const transformed = transform(
      Buffer.from(JSON.stringify({ commands: {} })),
      { url: '/v1/alpha/search' },
    );
    expect(JSON.parse(transformed)).toEqual({
      commands: {},
      settings: { filters: { allowed_domains: ['docs.github.com'] } },
    });
  });
});
