'use strict';

/**
 * Tests for containers/api-proxy/claude-hosted-web.js
 *
 * Covers the full precedence and failure matrix required by the AWF Claude
 * hosted-web policy: tool matching, disabled mode, allowlist injection /
 * intersection, blocklist injection / union, cross-mode conflicts, max_uses
 * clamping, malformed inputs, and startup policy parsing.
 */

const {
  ClaudeHostedWebPolicyError,
  isHostedWebToolType,
  isHostedWebToolCandidate,
  parseClaudeHostedWebPolicy,
  applyClaudeHostedWebPolicy,
  makeClaudeHostedWebTransform,
} = require('./claude-hosted-web');

const ALLOW_POLICY = { enabled: true, mode: 'allow', domains: ['docs.github.com', 'nodejs.org'] };
const BLOCK_POLICY = { enabled: true, mode: 'block', domains: ['untrusted.example'] };
const DISABLED_POLICY = { enabled: false, mode: null, domains: [] };

function messages(tools) {
  return { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }], tools };
}

function expectRejection(fn, code, statusCode) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ClaudeHostedWebPolicyError);
    expect(err.code).toBe(code);
    expect(err.statusCode).toBe(statusCode);
    return err;
  }
  throw new Error(`Expected rejection with code ${code}`);
}

describe('hosted web tool matcher', () => {
  it.each([
    'web_search_20250305',
    'web_search_20260209',
    'web_search_20260318',
    'web_fetch_20250910',
    'web_fetch_20991231',
  ])('recognizes documented and future version %s', (type) => {
    expect(isHostedWebToolType(type)).toBe(true);
    expect(isHostedWebToolCandidate(type)).toBe(true);
  });

  it.each([
    'web_search',
    'web_search_',
    'web_search_2025030',
    'web_search_202503055',
    'web_search_20251305',
    'web_search_20250332',
    'web_fetch_latest',
    'web_fetch_v2',
  ])('treats lookalike %s as an unrecognized hosted tool', (type) => {
    expect(isHostedWebToolType(type)).toBe(false);
    expect(isHostedWebToolCandidate(type)).toBe(true);
  });

  it.each([
    'bash_20250124',
    'web_searcher_20250305',
    'text_editor_20250124',
    'custom_tool',
    undefined,
    42,
  ])('does not treat %s as a hosted web tool at all', (type) => {
    expect(isHostedWebToolCandidate(type)).toBe(false);
    expect(isHostedWebToolType(type)).toBe(false);
  });
});

describe('parseClaudeHostedWebPolicy', () => {
  it('returns null when unset or blank', () => {
    expect(parseClaudeHostedWebPolicy(undefined)).toBeNull();
    expect(parseClaudeHostedWebPolicy(null)).toBeNull();
    expect(parseClaudeHostedWebPolicy('  ')).toBeNull();
  });

  it('parses an allowlist policy', () => {
    expect(parseClaudeHostedWebPolicy(JSON.stringify({ ...ALLOW_POLICY, maxUses: 5 }))).toEqual({
      enabled: true, mode: 'allow', domains: ['docs.github.com', 'nodejs.org'], maxUses: 5,
    });
  });

  it('parses a disabled policy without requiring a domain mode', () => {
    expect(parseClaudeHostedWebPolicy('{"enabled":false}')).toEqual({
      enabled: false, mode: null, domains: [],
    });
  });

  it.each([
    ['not json', 'not-json'],
    ['non-object', '"nope"'],
    ['missing enabled', '{}'],
    ['missing mode', '{"enabled":true,"domains":["a.com"]}'],
    ['bad mode', '{"enabled":true,"mode":"maybe","domains":["a.com"]}'],
    ['empty domains', '{"enabled":true,"mode":"allow","domains":[]}'],
    ['invalid domain', '{"enabled":true,"mode":"allow","domains":["https://a.com"]}'],
    ['ip domain', '{"enabled":true,"mode":"allow","domains":["10.0.0.1"]}'],
    ['single label', '{"enabled":true,"mode":"allow","domains":["localhost"]}'],
    ['bad maxUses', '{"enabled":true,"mode":"allow","domains":["a.com"],"maxUses":0}'],
  ])('throws at startup for %s', (_label, raw) => {
    expect(() => parseClaudeHostedWebPolicy(raw)).toThrow(/AWF_CLAUDE_HOSTED_WEB_POLICY/);
  });
});

describe('applyClaudeHostedWebPolicy', () => {
  it('leaves a request without any hosted web tool unchanged', () => {
    expect(applyClaudeHostedWebPolicy(messages([{ type: 'bash_20250124', name: 'bash' }]), ALLOW_POLICY)).toBeNull();
    expect(applyClaudeHostedWebPolicy(messages(undefined), ALLOW_POLICY)).toBeNull();
    expect(applyClaudeHostedWebPolicy({ messages: [] }, DISABLED_POLICY)).toBeNull();
  });

  it('rejects hosted search when disabled', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', name: 'web_search' }]), DISABLED_POLICY),
      'claude_hosted_web_disabled', 403,
    );
  });

  it('rejects hosted fetch when disabled', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(messages([{ type: 'web_fetch_20250910', name: 'web_fetch' }]), DISABLED_POLICY),
      'claude_hosted_web_disabled', 403,
    );
  });

  it('injects the configured allowlist when the request omits filters', () => {
    const result = applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', name: 'web_search' }]), ALLOW_POLICY);
    expect(result.tools[0]).toEqual({
      type: 'web_search_20250305', name: 'web_search', allowed_domains: ['docs.github.com', 'nodejs.org'],
    });
  });

  it('intersects a narrowing request allowlist', () => {
    const result = applyClaudeHostedWebPolicy(
      messages([{ type: 'web_search_20250305', name: 'web_search', allowed_domains: ['nodejs.org'] }]),
      ALLOW_POLICY,
    );
    expect(result.tools[0].allowed_domains).toEqual(['nodejs.org']);
  });

  it('cannot be broadened by a request allowlist', () => {
    const result = applyClaudeHostedWebPolicy(
      messages([{ type: 'web_fetch_20250910', allowed_domains: ['nodejs.org', 'evil.example'] }]),
      ALLOW_POLICY,
    );
    expect(result.tools[0].allowed_domains).toEqual(['nodejs.org']);
  });

  it('rejects an empty allowlist intersection', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(
        messages([{ type: 'web_search_20250305', allowed_domains: ['evil.example'] }]),
        ALLOW_POLICY,
      ),
      'claude_hosted_web_empty_intersection', 403,
    );
  });

  it('injects the configured blocklist when the request omits filters', () => {
    const result = applyClaudeHostedWebPolicy(messages([{ type: 'web_fetch_20250910' }]), BLOCK_POLICY);
    expect(result.tools[0].blocked_domains).toEqual(['untrusted.example']);
  });

  it('unions a request blocklist and keeps configured entries', () => {
    const result = applyClaudeHostedWebPolicy(
      messages([{ type: 'web_search_20250305', blocked_domains: ['ads.example'] }]),
      BLOCK_POLICY,
    );
    expect(result.tools[0].blocked_domains).toEqual(['untrusted.example', 'ads.example']);
  });

  it('cannot remove a configured blocked domain', () => {
    const result = applyClaudeHostedWebPolicy(
      messages([{ type: 'web_search_20250305', blocked_domains: ['other.example'] }]),
      BLOCK_POLICY,
    );
    expect(result.tools[0].blocked_domains).toContain('untrusted.example');
  });

  it('rejects blocked_domains in allowlist mode', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(
        messages([{ type: 'web_search_20250305', blocked_domains: ['ads.example'] }]),
        ALLOW_POLICY,
      ),
      'claude_hosted_web_policy_conflict', 403,
    );
  });

  it('rejects allowed_domains in blocklist mode', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(
        messages([{ type: 'web_search_20250305', allowed_domains: ['docs.github.com'] }]),
        BLOCK_POLICY,
      ),
      'claude_hosted_web_policy_conflict', 403,
    );
  });

  it('rejects a request declaring both filters', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(
        messages([{ type: 'web_search_20250305', allowed_domains: ['docs.github.com'], blocked_domains: ['ads.example'] }]),
        ALLOW_POLICY,
      ),
      'claude_hosted_web_policy_conflict', 403,
    );
  });

  it('uses the lower of configured and requested max_uses', () => {
    const policy = { ...ALLOW_POLICY, maxUses: 5 };
    expect(applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305' }]), policy).tools[0].max_uses).toBe(5);
    expect(applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', max_uses: 2 }]), policy).tools[0].max_uses).toBe(2);
    expect(applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', max_uses: 50 }]), policy).tools[0].max_uses).toBe(5);
  });

  it('keeps a request max_uses when no cap is configured', () => {
    expect(applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', max_uses: 3 }]), ALLOW_POLICY).tools[0].max_uses).toBe(3);
  });

  it.each([0, -1, 1.5, '3', null])('rejects malformed max_uses %p', (maxUses) => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', max_uses: maxUses }]), ALLOW_POLICY),
      'claude_hosted_web_max_uses_invalid', 400,
    );
  });

  it.each([
    [[], 'claude_hosted_web_tool_invalid'],
    ['docs.github.com', 'claude_hosted_web_tool_invalid'],
    [['https://docs.github.com'], 'claude_hosted_web_domain_invalid'],
    [['*.github.com'], 'claude_hosted_web_domain_invalid'],
    [[42], 'claude_hosted_web_domain_invalid'],
  ])('rejects malformed allowed_domains %p before upstream dispatch', (allowed, code) => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(messages([{ type: 'web_search_20250305', allowed_domains: allowed }]), ALLOW_POLICY),
      code, 400,
    );
  });

  it('rejects an unrecognized hosted tool version instead of forwarding it unprotected', () => {
    expectRejection(
      () => applyClaudeHostedWebPolicy(messages([{ type: 'web_search_vNext' }]), ALLOW_POLICY),
      'claude_hosted_web_tool_unrecognized', 400,
    );
  });

  it('enforces every matching tool in one request', () => {
    const result = applyClaudeHostedWebPolicy(
      messages([
        { type: 'web_search_20250305' },
        { type: 'bash_20250124', name: 'bash' },
        { type: 'web_fetch_20250910', allowed_domains: ['nodejs.org'] },
      ]),
      ALLOW_POLICY,
    );
    expect(result.tools[0].allowed_domains).toEqual(['docs.github.com', 'nodejs.org']);
    expect(result.tools[1]).toEqual({ type: 'bash_20250124', name: 'bash' });
    expect(result.tools[2].allowed_domains).toEqual(['nodejs.org']);
  });

  it('does not include request content in policy errors', () => {
    const err = expectRejection(
      () => applyClaudeHostedWebPolicy(
        { model: 'claude-x', messages: [{ role: 'user', content: 'secret prompt' }],
          tools: [{ type: 'web_search_20250305', allowed_domains: ['evil.example'] }] },
        ALLOW_POLICY,
      ),
      'claude_hosted_web_empty_intersection', 403,
    );
    expect(err.message).not.toMatch(/secret prompt|evil\.example/);
  });
});

describe('makeClaudeHostedWebTransform', () => {
  it('returns null (no-op) when no policy is configured', () => {
    expect(makeClaudeHostedWebTransform(null)).toBeNull();
  });

  it('serializes the enforced policy into the upstream body', () => {
    const transform = makeClaudeHostedWebTransform({ ...ALLOW_POLICY, maxUses: 4 });
    const input = Buffer.from(JSON.stringify(messages([{ type: 'web_search_20250305' }])), 'utf8');
    expect(JSON.parse(transform(input).toString('utf8')).tools).toEqual([
      { type: 'web_search_20250305', allowed_domains: ['docs.github.com', 'nodejs.org'], max_uses: 4 },
    ]);
  });

  it('passes non-JSON and non-matching bodies through unchanged', () => {
    const transform = makeClaudeHostedWebTransform(ALLOW_POLICY);
    expect(transform(Buffer.from('not json', 'utf8'))).toBeNull();
    expect(transform(Buffer.from(JSON.stringify(messages(undefined)), 'utf8'))).toBeNull();
  });

  it('is idempotent', () => {
    const transform = makeClaudeHostedWebTransform(ALLOW_POLICY);
    const first = transform(Buffer.from(JSON.stringify(messages([{ type: 'web_search_20250305' }])), 'utf8'));
    expect(transform(first)).toBeNull();
  });
});
