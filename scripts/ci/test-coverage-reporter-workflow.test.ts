import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'test-coverage-reporter.md');
const lockPath = path.join(workflowsDir, 'test-coverage-reporter.lock.yml');

describe('test coverage reporter workflow token optimization config', () => {
  it('removes unused tool injection and trims precomputed coverage context in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('github: false');
    expect(source).toContain('bash: false');
    expect(source).not.toContain('toolsets: [repos, discussions]');
    expect(source).not.toContain('bash: true');
    expect(source).toContain('const SECURITY_CRITICAL = [');
    expect(source).toContain("'docker-manager'");
    expect(source).toContain("'host-iptables'");
    expect(source).toContain("'squid-config'");
    expect(source).toContain("'domain-patterns'");
    expect(source).toContain("'cli'");
    expect(source).toContain('.filter(r => r.stmts < 80 || SECURITY_CRITICAL.some(s => r.file.includes(s)))');

    // Token optimization: coverage-json step removed (COVERAGE_TABLE alone is sufficient)
    expect(source).not.toContain('coverage-json');
    expect(source).not.toContain('COVERAGE_JSON');

    // Token optimization: pre-built discussion template step added
    expect(source).toContain('Pre-build discussion template');
    expect(source).toContain('id: discussion-template');
    expect(source).toContain('DISCUSSION_BODY');

    // Token optimization: push trigger has paths filter to reduce run frequency
    expect(source).toContain("paths:");
    expect(source).toContain("- 'src/**/*.ts'");

    // Token optimization: FUNC_AUDIT uses branch counts instead of misleading ternary line listing
    expect(source).toContain('branch count');
    expect(source).toContain('if-branches:');
    expect(source).not.toContain('\\?.*:');
  });

  it('compiles without GitHub MCP server injection while preserving safeoutputs reporting', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).not.toContain('ghcr.io/github/github-mcp-server');
    expect(lock).not.toContain('GITHUB_TOOLSETS');
    expect(lock).not.toContain('github_mcp_tools_with_safeoutputs_prompt.md');
    expect(lock).toContain('GH_AW_MCP_CLI_SERVERS_LIST: \'- `safeoutputs` — run `safeoutputs --help` to see available tools\'');
    expect(lock).toContain('"safeoutputs": {');
    expect(lock).not.toContain('"github": {');
    expect(lock).not.toContain('shell(');
    expect(lock).toContain('const SECURITY_CRITICAL = [');
    expect(lock).toContain('.filter(r => r.stmts < 80 || SECURITY_CRITICAL.some(s => r.file.includes(s)))');

    // Token optimization: coverage-json step removed
    expect(lock).not.toContain('coverage-json');
    expect(lock).not.toContain('COVERAGE_JSON');

    // Token optimization: pre-built discussion template step compiled correctly
    expect(lock).toContain('id: discussion-template');
    expect(lock).toContain('DISCUSSION_BODY');

    // Token optimization: push trigger paths filter present in compiled workflow
    expect(lock).toContain('paths:');
    expect(lock).toContain('src/**/*.ts');

    // Token optimization: FUNC_AUDIT uses branch counts (not ternary line listing)
    expect(lock).toContain('branch count');
    expect(lock).toContain('if-branches:');

    // Expression variables are passed via env entries that expand at runtime
    const exprEnvLines = lock.match(/GH_AW_EXPR_[A-F0-9]+: \$\{\{.+\}\}/g) || [];
    expect(exprEnvLines.length).toBeGreaterThan(0);
  });
});
