import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'contribution-check.md');

describe('contribution-check workflow', () => {
  it('pre-fetches PR diff, metadata, and CONTRIBUTING.md in pre-agent steps', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Pre-fetch steps using GH_TOKEN (not relying on in-sandbox proxy)
    expect(source).toContain('Fetch PR changed files');
    expect(source).toContain('Fetch PR metadata');
    expect(source).toContain('Fetch CONTRIBUTING.md');
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');

    // Steps write to context files (not $GITHUB_OUTPUT), so data persists for the agent
    expect(source).toContain('/tmp/gh-aw/contribution-check-context/contributing.md');
    expect(source).toContain('/tmp/gh-aw/contribution-check-context/pr-files.md');
    expect(source).toContain('/tmp/gh-aw/contribution-check-context/pr-meta.md');
  });

  it('instructs agent to use pre-fetched data and not re-fetch via proxy', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Agent reads from context files written by the pre-fetch steps
    expect(source).toContain('Read the following pre-fetched context files before proceeding');
    expect(source).toContain("Do NOT call `gh pr diff`");
    expect(source).toContain('Use ONLY the pre-fetched data in these context files');
  });

  it('has conservative turn limit and appropriate model', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 5');
    expect(source).toContain('model: gpt-5.4-mini');
  });
});
