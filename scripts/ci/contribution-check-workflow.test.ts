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
    expect(source).toContain('${{ steps.pr-diff.outputs.PR_FILES }}');
    expect(source).toContain('${{ steps.pr-meta.outputs.PR_META }}');
    expect(source).toContain('${{ steps.contributing.outputs.CONTENT }}');
  });

  it('instructs agent to use pre-fetched data and not re-fetch via proxy', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('Use ONLY the pre-fetched data below');
    expect(source).toContain("Do NOT call `gh pr diff`");
    expect(source).toContain('Do not read files from the checkout');
  });

  it('has conservative turn limit and appropriate model', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 5');
    expect(source).toContain('model: claude-haiku-4-5');
  });
});
