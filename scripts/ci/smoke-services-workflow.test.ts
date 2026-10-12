import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-services.md');
const lockPath = path.join(workflowsDir, 'smoke-services.lock.yml');

describe('Smoke Services workflow token optimization', () => {
  it('disables GitHub MCP and specifies ordered safe-output instructions', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const frontmatter = source.split(/^---$/m)[1];
    const prompt = source.split(/^---$/m)[2];

    expect(frontmatter).toContain('github: false');
    expect(frontmatter).toContain('bash:\n    - "*"');
    expect(prompt).toContain('item_number` from the triggering event');
    expect(prompt).toContain('github.event.pull_request.number');
    expect(prompt.indexOf('add_comment')).toBeLessThan(prompt.indexOf('add_labels'));
    expect(prompt).toContain('Do not call `noop`.');
  });

  it('compiles without GitHub MCP tool injection while retaining safe outputs', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).not.toContain('ghcr.io/github/github-mcp-server');
    expect(lock).not.toContain('GITHUB_TOOLSETS');
    expect(lock).not.toContain('github_mcp_tools_with_safeoutputs_prompt.md');
    expect(lock).not.toContain('"github": {');
    expect(lock).toContain('"mcp_servers":[{"name":"safeoutputs"');
    expect(lock).toContain('"add_comment","add_labels"');
  });
});
