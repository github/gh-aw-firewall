import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'refactoring-scanner.md');

describe('refactoring scanner workflow prompt', () => {
  it('requires a direct noop MCP call when no issues are created', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source.match(/`safeoutputs\.noop` MCP tool/g)).toHaveLength(2);
    expect(
      source.match(/Do not simulate this safe output with `bash`, `printf`, or a final text response\./g),
    ).toHaveLength(2);
  });
});
