import {
  addPortSafetyRules,
  addApiProxyAllowRules,
  addRawIpBlockRules,
  addAllowedIpRules,
  addDlpRules,
  addBlockedDomainRules,
  addProtocolAllowRules,
  addBothProtocolAllowRules,
  addDefaultDenyRule,
  PolicyRuleState,
} from './section-builders';

function makeState(): PolicyRuleState {
  return { rules: [], order: 0 };
}

describe('addPortSafetyRules', () => {
  it('adds two rules for port safety', () => {
    const state = makeState();
    addPortSafetyRules(state);
    expect(state.rules).toHaveLength(2);
    expect(state.rules[0].id).toBe('deny-unsafe-ports');
    expect(state.rules[1].id).toBe('deny-connect-unsafe-ports');
  });

  it('sets sequential order values', () => {
    const state = makeState();
    addPortSafetyRules(state);
    expect(state.rules[0].order).toBe(1);
    expect(state.rules[1].order).toBe(2);
  });

  it('deny-unsafe-ports has action deny and protocol both', () => {
    const state = makeState();
    addPortSafetyRules(state);
    expect(state.rules[0].action).toBe('deny');
    expect(state.rules[0].protocol).toBe('both');
  });

  it('deny-connect-unsafe-ports has action deny and protocol https', () => {
    const state = makeState();
    addPortSafetyRules(state);
    expect(state.rules[1].action).toBe('deny');
    expect(state.rules[1].protocol).toBe('https');
  });
});

describe('addApiProxyAllowRules', () => {
  it('does not add rules when apiProxyIp is undefined', () => {
    const state = makeState();
    addApiProxyAllowRules(state, undefined);
    expect(state.rules).toHaveLength(0);
  });

  it('adds two rules when apiProxyIp is provided', () => {
    const state = makeState();
    addApiProxyAllowRules(state, '172.30.0.30');
    expect(state.rules).toHaveLength(2);
    expect(state.rules[0].id).toBe('allow-api-proxy-ip');
    expect(state.rules[1].id).toBe('allow-from-api-proxy');
  });

  it('includes the apiProxyIp in the allow-api-proxy-ip rule domains', () => {
    const state = makeState();
    addApiProxyAllowRules(state, '172.30.0.30');
    expect(state.rules[0].domains).toContain('172.30.0.30');
  });
});

describe('addRawIpBlockRules', () => {
  it('adds two deny rules for IPv4 and IPv6', () => {
    const state = makeState();
    addRawIpBlockRules(state);
    expect(state.rules).toHaveLength(2);
    expect(state.rules[0].id).toBe('deny-raw-ipv4');
    expect(state.rules[1].id).toBe('deny-raw-ipv6');
  });

  it('both rules have action deny', () => {
    const state = makeState();
    addRawIpBlockRules(state);
    expect(state.rules[0].action).toBe('deny');
    expect(state.rules[1].action).toBe('deny');
  });
});

describe('addAllowedIpRules', () => {
  it('does not add rules when domains is undefined', () => {
    const state = makeState();
    addAllowedIpRules(state, undefined);
    expect(state.rules).toHaveLength(0);
  });

  it('does not add rules when no IPs in domains', () => {
    const state = makeState();
    addAllowedIpRules(state, ['github.com', 'example.com']);
    expect(state.rules).toHaveLength(0);
  });

  it('adds a rule for each raw IPv4 address in domains', () => {
    const state = makeState();
    addAllowedIpRules(state, ['192.168.1.1', 'github.com', '10.0.0.1']);
    expect(state.rules).toHaveLength(2);
    expect(state.rules[0].id).toBe('allow-ip-192-168-1-1');
    expect(state.rules[1].id).toBe('allow-ip-10-0-0-1');
  });

  it('rule domains contain the IP address', () => {
    const state = makeState();
    addAllowedIpRules(state, ['192.168.1.1']);
    expect(state.rules[0].domains).toContain('192.168.1.1');
  });

  it('rule aclName uses underscores instead of dots', () => {
    const state = makeState();
    addAllowedIpRules(state, ['192.168.1.1']);
    expect(state.rules[0].aclName).toBe('allow_ip_192_168_1_1');
  });
});

describe('addDlpRules', () => {
  it('does not add rules when enableDlp is false', () => {
    const state = makeState();
    addDlpRules(state, false);
    expect(state.rules).toHaveLength(0);
  });

  it('does not add rules when enableDlp is undefined', () => {
    const state = makeState();
    addDlpRules(state, undefined);
    expect(state.rules).toHaveLength(0);
  });

  it('adds a deny-dlp rule when enableDlp is true', () => {
    const state = makeState();
    addDlpRules(state, true);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].id).toBe('deny-dlp');
    expect(state.rules[0].action).toBe('deny');
  });
});

describe('addBlockedDomainRules', () => {
  it('does not add rules when blockedDomains is undefined', () => {
    const state = makeState();
    addBlockedDomainRules(state, undefined);
    expect(state.rules).toHaveLength(0);
  });

  it('does not add rules when blockedDomains is empty', () => {
    const state = makeState();
    addBlockedDomainRules(state, []);
    expect(state.rules).toHaveLength(0);
  });

  it('adds a deny rule for plain blocked domains', () => {
    const state = makeState();
    addBlockedDomainRules(state, ['evil.com']);
    expect(state.rules.some(r => r.id === 'deny-blocked-plain')).toBe(true);
    const rule = state.rules.find(r => r.id === 'deny-blocked-plain')!;
    expect(rule.action).toBe('deny');
    expect(rule.aclName).toBe('blocked_domains');
  });

  it('adds a deny rule for wildcard blocked patterns', () => {
    const state = makeState();
    addBlockedDomainRules(state, ['*.evil.com']);
    expect(state.rules.some(r => r.id === 'deny-blocked-regex')).toBe(true);
  });

  it('strips protocol prefix from blocked domains', () => {
    const state = makeState();
    addBlockedDomainRules(state, ['https://evil.com/']);
expect(state.rules.find(r => r.id === 'deny-blocked-plain')?.domains).toEqual(['.evil.com']);
  });
});

describe('addProtocolAllowRules', () => {
  it('adds no rules when all protocol arrays are empty', () => {
    const state = makeState();
    addProtocolAllowRules(
      state,
      { http: [], https: [], both: [] },
      { http: [], https: [], both: [] }
    );
    expect(state.rules).toHaveLength(0);
  });

  it('adds allow-http-only-plain rule when http domains exist', () => {
    const state = makeState();
    addProtocolAllowRules(
      state,
      { http: ['example.com'], https: [], both: [] },
      { http: [], https: [], both: [] }
    );
    expect(state.rules.some(r => r.id === 'allow-http-only-plain')).toBe(true);
    const rule = state.rules.find(r => r.id === 'allow-http-only-plain')!;
    expect(rule.action).toBe('allow');
    expect(rule.protocol).toBe('http');
  });

  it('adds allow-http-only-regex rule when http patterns exist', () => {
    const state = makeState();
    addProtocolAllowRules(
      state,
      { http: [], https: [], both: [] },
      { http: [{ regex: 'example\\.com', protocol: 'http', original: '*.example.com' }], https: [], both: [] }
    );
    expect(state.rules.some(r => r.id === 'allow-http-only-regex')).toBe(true);
  });

  it('adds allow-https-only-plain rule when https domains exist', () => {
    const state = makeState();
    addProtocolAllowRules(
      state,
      { http: [], https: ['secure.com'], both: [] },
      { http: [], https: [], both: [] }
    );
    expect(state.rules.some(r => r.id === 'allow-https-only-plain')).toBe(true);
    const rule = state.rules.find(r => r.id === 'allow-https-only-plain')!;
    expect(rule.protocol).toBe('https');
  });

  it('adds allow-https-only-regex rule when https patterns exist', () => {
    const state = makeState();
    addProtocolAllowRules(
      state,
      { http: [], https: [], both: [] },
      { http: [], https: [{ regex: 'secure\\.com', protocol: 'https', original: '*.secure.com' }], both: [] }
    );
    expect(state.rules.some(r => r.id === 'allow-https-only-regex')).toBe(true);
  });
});

describe('addBothProtocolAllowRules', () => {
  it('adds no rules when both arrays are empty', () => {
    const state = makeState();
    addBothProtocolAllowRules(state, { http: [], https: [], both: [] }, { http: [], https: [], both: [] });
    expect(state.rules).toHaveLength(0);
  });

  it('adds allow-both-plain rule when both domains exist', () => {
    const state = makeState();
    addBothProtocolAllowRules(
      state,
      { http: [], https: [], both: ['github.com'] },
      { http: [], https: [], both: [] }
    );
    expect(state.rules.some(r => r.id === 'allow-both-plain')).toBe(true);
    const rule = state.rules.find(r => r.id === 'allow-both-plain')!;
    expect(rule.action).toBe('allow');
    expect(rule.protocol).toBe('both');
    expect(rule.aclName).toBe('allowed_domains');
  });

  it('adds allow-both-regex rule when both patterns exist', () => {
    const state = makeState();
    addBothProtocolAllowRules(
      state,
      { http: [], https: [], both: [] },
      { http: [], https: [], both: [{ regex: 'github\\.com', protocol: 'both', original: '*.github.com' }] }
    );
    expect(state.rules.some(r => r.id === 'allow-both-regex')).toBe(true);
    const rule = state.rules.find(r => r.id === 'allow-both-regex')!;
    expect(rule.aclName).toBe('allowed_domains_regex');
  });

  it('adds both rules when domains and patterns exist', () => {
    const state = makeState();
    addBothProtocolAllowRules(
      state,
      { http: [], https: [], both: ['github.com'] },
      { http: [], https: [], both: [{ regex: 'github\\.com', protocol: 'both', original: '*.github.com' }] }
    );
    expect(state.rules).toHaveLength(2);
  });
});

describe('addDefaultDenyRule', () => {
  it('adds a single deny-default rule', () => {
    const state = makeState();
    addDefaultDenyRule(state);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].id).toBe('deny-default');
    expect(state.rules[0].action).toBe('deny');
    expect(state.rules[0].aclName).toBe('all');
  });

  it('increments order correctly relative to prior rules', () => {
    const state = makeState();
    addPortSafetyRules(state);
    addDefaultDenyRule(state);
    expect(state.rules[state.rules.length - 1].order).toBe(3);
  });
});
