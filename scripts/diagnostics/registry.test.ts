import * as fs from 'fs';
import * as path from 'path';

import {
  BOUNDARIES,
  checkSync,
  loadFindings,
  renderOutputs,
  searchFindings,
  validateFindings,
  REPO_ROOT,
} from './registry';

const loaded = loadFindings();

describe('diagnosis registry', () => {
  it('loads canonical findings deterministically', () => {
    expect(loaded.length).toBeGreaterThan(0);
    const ids = loaded.map((entry) => entry.finding.id);
    expect(ids).toEqual([...ids].sort((a, b) => {
      const rank = (id: string) =>
        BOUNDARIES.indexOf(
          loaded.find((entry) => entry.finding.id === id)!.finding.boundary
        );
      return rank(a) - rank(b) || a.localeCompare(b, 'en');
    }));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes schema, ID, provenance and safety validation', () => {
    expect(validateFindings(loaded)).toEqual([]);
  });

  it('retains the historical runner catalog ID namespace', () => {
    const runnerIds = loaded
      .filter((entry) => entry.finding.boundary === 'runner')
      .map((entry) => entry.finding.id);
    expect(runnerIds).toContain('A1');
    for (const id of runnerIds) expect(id).toMatch(/^[A-D][0-9]{1,3}$/);
  });

  it('keeps every probe read-only and secret-safe', () => {
    for (const { finding } of loaded) {
      expect(finding.probe.readOnly).toBe(true);
      expect(finding.probe.secretSafe).toBe(true);
      expect(finding.probe.command).not.toMatch(/--env-all|printenv|Authorization:/i);
    }
  });

  it('keeps generated artifacts in sync with the canonical records', () => {
    expect(checkSync(loaded).stale).toEqual([]);
  });

  it('renders deterministically', () => {
    const first = renderOutputs(loaded);
    const second = renderOutputs(loaded);
    expect(first).toEqual(second);
    for (const output of first) {
      expect(output.content).toContain('A1');
    }
  });
});

describe('diagnosis registry validation rules', () => {
  const base = loaded.find((entry) => entry.finding.id === 'A1')!;

  function mutate(mutation: (finding: typeof base.finding) => void) {
    const clone = JSON.parse(JSON.stringify(base.finding));
    mutation(clone);
    return [{ finding: clone, source: base.source }];
  }

  it('rejects an ID outside the boundary namespace', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.id = 'NET-001';
      })
    );
    expect(errors.join('\n')).toMatch(/must be stored at|namespace/);
  });

  it('rejects duplicate IDs', () => {
    const errors = validateFindings([base, { ...base, source: 'docs/diagnostics/findings/runner/A1.json' }]);
    expect(errors.join('\n')).toMatch(/duplicate finding ID A1/);
  });

  it('rejects a probe that dumps the environment', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.probe.command = 'printenv';
      })
    );
    expect(errors.join('\n')).toMatch(/unsafe probe/);
  });

  it('rejects a probe that reads process environment files', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.probe.command = 'cat /proc/self/environ';
      })
    );
    expect(errors.join('\n')).toMatch(/unsafe probe/);
  });

  it('rejects an action that recommends an isolation bypass', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.action = 'Re-run with --env-all to expose the environment.';
      })
    );
    expect(errors.join('\n')).toMatch(/unsafe action/);
  });

  it('rejects a credential-bearing sample value', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.rootCause = 'The token ghp_abcdefghijklmnop was rejected.';
      })
    );
    expect(errors.join('\n')).toMatch(/unsafe content/);
  });

  it('rejects a broken reference path', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.references = [{ kind: 'code', ref: 'src/does-not-exist.ts' }];
      })
    );
    expect(errors.join('\n')).toMatch(/does not exist/);
  });

  it('rejects a reference path that escapes the repository', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.references = [{ kind: 'code', ref: '../../../../../etc/passwd' }];
      })
    );
    expect(errors.join('\n')).toMatch(/must stay within the repository/);
  });

  it('rejects a doc-only provenance set', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.references = [{ kind: 'doc', ref: 'docs/arc-dind.md' }];
      })
    );
    expect(errors.join('\n')).toMatch(/provenance reference/);
  });

  it('requires implementation or test evidence for fixed records', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.status = 'fixed';
        finding.versions.fixed = '1.2.3';
        finding.references = [
          { kind: 'pull-request', ref: 'https://github.com/github/gh-aw-firewall/pull/1' },
        ];
      })
    );
    expect(errors.join('\n')).toMatch(/implementation\/test citation/);
  });

  it('rejects an unknown related finding ID', () => {
    const errors = validateFindings(
      mutate((finding) => {
        finding.related = ['NET-999'];
      })
    );
    expect(errors.join('\n')).toMatch(/related references unknown finding/);
  });
});

describe('diagnosis routing fixtures', () => {
  const fixtures: { name: string; query: Parameters<typeof searchFindings>[1]; expected: string }[] = [
    {
      name: 'ARC split-filesystem bind failure',
      query: {
        text: 'Bind-mounted workspace files are missing inside the agent container on our ARC runner',
        runner: 'arc-dind',
      },
      expected: 'A1',
    },
    {
      name: 'Squid denial',
      query: { text: 'curl failed: TCP_DENIED 403 Forbidden returned by the proxy for an outbound request' },
      expected: 'NET-001',
    },
    {
      name: 'DNS denial',
      query: { text: 'curl: (6) Could not resolve host: api.example.com, Temporary failure in name resolution' },
      expected: 'NET-002',
    },
    {
      name: 'enterprise Copilot header failure',
      query: {
        text: '400 Bad Request: Authorization header is badly formatted',
        provider: 'copilot',
      },
      expected: 'AUTH-001',
    },
    {
      name: 'API-proxy OIDC configuration error',
      query: {
        text: 'api-proxy reports that no OIDC token could be minted and ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar',
        authMode: 'github-oidc',
      },
      expected: 'AUTH-002',
    },
    {
      name: 'mcpg OIDC boundary failure',
      query: {
        text: 'mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication',
        authMode: 'github-oidc',
      },
      expected: 'AUTH-003',
    },
    {
      name: 'CI safe-output error',
      query: { text: 'safe output validation failed in the workflow run' },
      expected: 'CI-001',
    },
    {
      name: 'alternative runtime failure',
      query: { text: 'OCI runtime create failed with runsc' },
      expected: 'RT-001',
    },
    {
      name: 'suspected isolation regression',
      query: { text: 'The agent container can reach a domain that is not allowlisted' },
      expected: 'SEC-001',
    },
  ];

  for (const fixture of fixtures) {
    it(`routes ${fixture.name} to ${fixture.expected}`, () => {
      const matches = searchFindings(loaded, fixture.query);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].id).toBe(fixture.expected);
    });
  }

  it('returns no match for ambiguous input so the agent asks for a probe', () => {
    expect(searchFindings(loaded, { text: 'something went wrong' })).toEqual([]);
  });

  it('disqualifies explicit topology mismatches', () => {
    expect(
      searchFindings(loaded, {
        text: '400 Bad Request: Authorization header is badly formatted',
        provider: 'anthropic',
      }).map((match) => match.id)
    ).not.toContain('AUTH-001');
  });
});

describe('diagnosis discovery surfaces', () => {
  const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

  it('exposes the diagnose-awf skill with a routing description', () => {
    const skill = read('.github/skills/diagnose-awf/SKILL.md');
    expect(skill).toMatch(/^---\nname: diagnose-awf\n/);
    for (const keyword of ['auth', 'ARC', 'runtime', 'Squid', 'DNS', 'CI', 'security']) {
      expect(skill).toContain(keyword);
    }
    expect(skill).toContain('docs/diagnostics/README.md');
  });

  it('mirrors the skill into the .claude/skills layout', () => {
    expect(read('.claude/skills/diagnose-awf/SKILL.md')).toBe(
      read('.github/skills/diagnose-awf/SKILL.md')
    );
  });

  it('links the registry from the diagnosis and troubleshooting docs', () => {
    expect(read('docs/diagnosing-awf-failures.md')).toContain('docs/diagnostics');
    expect(read('docs/troubleshooting.md')).toContain('docs/diagnostics');
    expect(read('README.md')).toContain('docs/diagnostics');
  });

  it('marks generated artifacts as generated', () => {
    for (const relative of [
      '.github/workflows/shared/diagnosis-findings.md',
      '.github/agents/diagnose-awf.md',
    ]) {
      expect(read(relative)).toContain('Do not edit by hand');
    }
  });
});
