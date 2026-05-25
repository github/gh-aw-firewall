import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'doc-maintainer.md');
const lockPath = path.join(workflowsDir, 'doc-maintainer.lock.yml');

describe('doc maintainer workflow optimization config', () => {
  it('disables unused tools and keeps condensed prompt sections in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('github: false');
    expect(source).toContain(
      '**PR Description**: Summarize updated docs, reference the triggering code changes, and list what was verified.'
    );
    expect(source).toContain('- Be conservative, accurate, minimal, and consistent with existing style.');
    expect(source).toContain(
      '**Success**: Review 7-day commits, update out-of-sync docs, verify examples, and create a clear PR summary.'
    );
    expect(source).not.toContain('## Edge Cases');
    expect(source).not.toContain('A successful run means:');
  });

  it('compiles tool disabling into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).not.toContain('mcp__github');
  });
});
