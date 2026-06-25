import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'duplicate-code-detector.md');
const lockPath = path.join(workflowsDir, 'duplicate-code-detector.lock.yml');

describe('duplicate code detector workflow optimization config', () => {
  it('moves discovery into pre-agent steps and constrains scope in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('steps:');
    expect(source).toContain('- name: Install jscpd');
    expect(source).toContain('Gather file metrics');
    expect(source).toContain('Run jscpd');
    expect(source).toContain('Grep pattern analysis');
    expect(source).toContain('- name: Check existing duplicate issues');
    expect(source).toContain('jscpd-top.json');
    expect(source).toContain('## Pre-Computed Analysis');
    expect(source).not.toContain('Skip directly to Phase 5');
    expect(source).toContain('## Scope Constraint');
    expect(source).toContain('Do NOT re-run discovery commands.');
    expect(source).toContain('Complete your analysis in ≤4 turns. File at most 3 issues per run.');
    expect(source).toContain('Do NOT call any GitHub MCP tools for this phase.');
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
    expect(lock).toContain('- name: Install jscpd');
    expect(lock).toContain('npm install -g jscpd 2>&1 | tail -3');
    expect(lock).toContain('Tools: create_issue(max:3), missing_tool, missing_data, noop');
    expect(lock).toContain('"create_issue":{"expires":720,"labels":["code-quality","refactoring"],"max":3');
    expect(lock).not.toContain(`GH_AW_INFO_ALLOWED_DOMAINS: '["node","github"]'`);
  });
});
