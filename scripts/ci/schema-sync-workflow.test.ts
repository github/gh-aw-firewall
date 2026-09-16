import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'schema-sync.md');
const lockPath = path.join(workflowsDir, 'schema-sync.lock.yml');

describe('schema sync workflow prompt', () => {
  it('uses the stable default sandbox runtime', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(source).not.toMatch(/runtime:\s*cloud-hypervisor/);
    expect(lock).not.toContain('--container-runtime cloud-hypervisor');
  });

  it('requires a direct noop MCP call when no schema updates are needed', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source.match(/`safeoutputs\.noop` MCP tool/g)).toHaveLength(2);
    expect(
      source.match(/Do not\s+simulate this safe\s+output with `bash`, `printf`, or a final text response\./g),
    ).toHaveLength(2);
  });
});
