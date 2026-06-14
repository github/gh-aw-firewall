import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'copilot-token-usage-analyzer.md');

describe('copilot token usage analyzer workflow prompt', () => {
  it('includes explicit compact-output guardrails to reduce AI credit usage', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('<summary><b>Top Per-Workflow Details</b></summary>');
    expect(source).toContain('include detailed bullets for at most the top 10 workflows by token usage');
    expect(source).toContain('if output size is high, trim detail instead of repeatedly reformatting the full report');
  });
});
