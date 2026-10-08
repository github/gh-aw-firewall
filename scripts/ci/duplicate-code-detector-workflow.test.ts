import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'duplicate-code-detector.md');
const lockPath = path.join(workflowsDir, 'duplicate-code-detector.lock.yml');

describe('duplicate code detector workflow optimization config', () => {
  it('moves discovery into pre-agent steps and constrains scope in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const prompt = source.split('\n---\n')[1];

    expect(source).toContain('prepare_analysis:');
    expect(source).toContain("if: needs.prepare_analysis.outputs.skip_agent != 'true'");
    expect(source).toContain('analysis: ${{ steps.bundle.outputs.analysis }}');
    expect(source).toContain('skip_agent: ${{ steps.bundle.outputs.skip_agent }}');
    expect(source).toContain('steps:');
    expect(source).toContain('uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(source).toContain('- name: Install jscpd');
    expect(source).toContain('Gather file metrics');
    expect(source).toContain('Run jscpd');
    expect(source).toContain('Grep pattern analysis');
    expect(source).toContain('- name: Check existing duplicate issues');
    expect(source).toContain('jscpd-top.json');
    expect(source).toContain('Duplicate code snippets (±5 lines around each location)');
    expect(source).toContain('snippet_start=$((start > 5 ? start - 5 : 1))');
    expect(source).toContain('contains($first) and contains($second)');
    expect(source).toContain('state == "OPEN"');
    expect(source).toContain('All top jscpd findings match locations in open duplicate-code issues');
    expect(source).toContain('## Pre-Computed Analysis Data');
    expect(source).toContain('${{ needs.prepare_analysis.outputs.analysis }}');
    expect(source).toContain('## Pre-Computed Analysis');
    expect(source).toContain('## Scope Constraint');
    expect(source).toContain('Do not run `pwd`, `cat`, discovery commands, or read source files');
    expect(source).toContain('Use at most 3 bash calls');
    expect(source).toContain('Complete in ≤3 turns.');
    expect(source).toContain('model: gpt-5.4-mini');
    expect(prompt).not.toContain('cat /tmp/gh-aw/code-metrics.txt');
    expect(prompt).not.toContain('cat /tmp/gh-aw/jscpd-top.json');
    expect(source).toContain('github: false');
    expect(source).toContain('No GitHub MCP tools are exposed to this workflow; use the pre-computed issue data only.');
    expect(source).toContain('existing-issues.json');
    expect(source).toContain('max: 3');
    expect(source).toContain('allowed:\n    - github');
    expect(source).not.toContain('allowed:\n    - node');
    expect(source).not.toContain('## Phase 1: Gather Codebase Metrics');
    expect(source).not.toContain('## Phase 2: Detect Structural Duplication');
    expect(source).not.toContain('## Phase 3: Detect Pattern-Level Duplication');
    expect(source).not.toContain('## Phase 4: Analyze Specific Known Duplication Areas');
  });

  it('compiles lock workflow with pre-steps and github-only allowed domains', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain(`GH_AW_INFO_ALLOWED_DOMAINS: '["github"]'`);
    expect(lock).toContain('prepare_analysis:');
    expect(lock).toContain('All top jscpd findings match locations in open duplicate-code issues');
    expect(lock).toContain('- name: Install jscpd');
    expect(lock).toContain('npm install -g jscpd 2>&1 | tail -3');
    expect(lock).toContain('Tools: create_issue(max:3), missing_tool, missing_data, noop');
    expect(lock).toContain('\\"create_issue\\":{\\"expires\\":720,\\"labels\\":[\\"code-quality\\",\\"refactoring\\"],\\"max\\":3');
    expect(lock).toContain(
      '"mcp_servers":[{"name":"safeoutputs","tools":["create_issue","missing_data","missing_tool","noop","report_incomplete"]}]'
    );
    expect(lock).not.toContain('github_mcp_tools_with_safeoutputs_prompt.md');
    expect(lock).not.toContain('GITHUB_TOOLSETS');
    expect(lock).not.toContain('ghcr.io/github/github-mcp-server');
    expect(lock).not.toContain(`GH_AW_INFO_ALLOWED_DOMAINS: '["node","github"]'`);
  });
});
