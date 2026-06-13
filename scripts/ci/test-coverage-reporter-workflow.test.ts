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
    expect(source).toContain("k === 'total' ? k : k.replace(process.cwd() + '/', '')");
    expect(source).toContain('const SECURITY_CRITICAL = [');
    expect(source).toContain("'docker-manager'");
    expect(source).toContain("'host-iptables'");
    expect(source).toContain("'squid-config'");
    expect(source).toContain("'domain-patterns'");
    expect(source).toContain("'cli'");
    expect(source).toContain('.filter(r => r.stmts < 80 || SECURITY_CRITICAL.some(s => r.file.includes(s)))');
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
    expect(lock).toContain('k === \'total\' ? k : k.replace(process.cwd() + \'/\', \'\')');
    expect(lock).toContain('const SECURITY_CRITICAL = [');
    expect(lock).toContain('.filter(r => r.stmts < 80 || SECURITY_CRITICAL.some(s => r.file.includes(s)))');
  });
});
