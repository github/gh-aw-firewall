import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'schema-sync.md');

describe('schema sync workflow prompt', () => {
  it('requires a direct noop MCP call when no schema updates are needed', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('`safeoutputs.noop` MCP tool');
    expect(source).toContain('Do not simulate this safe\noutput with `bash`, `printf`, or a final text response.');
  });
});
