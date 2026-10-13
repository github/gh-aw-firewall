import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'issue-duplication-detector.md');
const lockPath = path.join(workflowsDir, 'issue-duplication-detector.lock.yml');

describe('issue duplication detector workflow optimization', () => {
  it('prepares issue data, limits tools, and updates cache deterministically', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const prompt = source.split('\n---\n')[1];

    expect(source).toContain('toolsets: [issues, search]');
    expect(source).toContain('    - cat');
    expect(source).toContain('name: Fetch issue and cached signatures');
    expect(source).toContain('gh issue view "$ISSUE_NUMBER"');
    expect(source).toContain('/tmp/gh-aw/agent/cached-issues.json');
    expect(source).not.toContain('post-steps:');
    expect(source.indexOf('cp "$cache"')).toBeLessThan(source.indexOf('jq -s'));
    expect(source).toContain('key_phrases:');
    expect(source).toContain('| .[-100:]');
    expect(prompt).not.toContain('list up to 20 open issues');
    expect(prompt).not.toContain('cat > /tmp/gh-aw/cache-memory/issues.json');
  });

  it('compiles the optimized workflow into the lockfile', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain(
      '"mcp_servers":[{"name":"github","tools":["issue_read","list_issue_types","list_issues","search_issues"]}',
    );
    expect(lock).not.toContain('"search_repositories"');
    expect(lock).toContain('Fetch issue and cached signatures');
    const update = lock.indexOf('mv \\"$cache.tmp\\" \\"$cache\\"');
    expect(update).toBeGreaterThan(lock.indexOf('Fetch issue and cached signatures'));
    expect(update).toBeLessThan(lock.indexOf('name: Execute GitHub Copilot CLI'));
    expect(update).toBeLessThan(lock.indexOf('name: Scan cache-memory'));
    expect(update).toBeLessThan(lock.indexOf('name: Commit cache-memory changes'));
    expect(lock).toContain('gh issue view');
    expect(lock).toContain('ISSUE_NUMBER');
  });

  it('targets the prepared issue for comments on opened issues and manual dispatches', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(source).toContain('github.event.issue.number || inputs.issue_number');
    expect(source).toContain('add-comment:\n    max: 1\n    target: "*"');
    expect(source).toContain(
      'Set `item_number` to the `number` from `/tmp/gh-aw/agent/new-issue.json`',
    );
    expect(lock).toContain('\\"add_comment\\":{\\"max\\":1,\\"target\\":\\"*\\"}');
  });
});
