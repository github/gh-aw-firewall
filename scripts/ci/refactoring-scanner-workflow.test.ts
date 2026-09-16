import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'refactoring-scanner.md');

describe('refactoring scanner workflow prompt', () => {
  it('requires a direct noop MCP call when no issues are created', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toMatch(
      /- \*\*No significant issues found\*\*:[^\n]*`safeoutputs\.noop`/,
    );
    expect(source).toMatch(
      /- \*\*All findings already tracked\*\*:[^\n]*`safeoutputs\.noop`/,
    );
  });
});
