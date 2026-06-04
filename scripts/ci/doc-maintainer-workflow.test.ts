import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'doc-maintainer.md');
const lockPath = path.join(workflowsDir, 'doc-maintainer.lock.yml');

describe('doc maintainer workflow optimization config', () => {
  it('disables unused tools and keeps condensed prompt sections in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('if: needs.check_relevant_changes.outputs.has_changes == \'true\'');
    expect(source).toContain('max-turns: 10');
    expect(source).toContain('bash: false');
    expect(source).toContain('github: false');
    expect(source).toContain('Read `/tmp/gh-aw/doc-maintainer-context/context.md` first.');
    expect(source).toContain('Use the **Recent Git Diffs** section from that file as your **sole source**');
    expect(source).toContain('**Do not run any `git` commands**');
    expect(source).toContain('files listed under **Affected Documentation** in `/tmp/gh-aw/doc-maintainer-context/context.md`');
    expect(source).toContain('echo "## Changes"');
    expect(source).toContain('echo "## Affected Documentation"');
    expect(source).toContain('echo "## Recent Git Diffs"');
    expect(source).toContain("git log --since=\"7 days ago\" --format=\"=== Commit %H: %s ===\" --patch --stat --unified=1 -- src/ containers/ scripts/ docs/ '*.md' | grep -v '^Binary' | head -100");
    expect(source).toContain("grep -i -F -f \"$TOKENS\" \"$DOC_POOL\" | head -10 > \"$AFFECTED\" || true");
    expect(source).toContain(
      '**PR Description**: Summarize updated docs, reference the triggering code changes, and list what was verified.'
    );
    expect(source).toContain('- Be conservative, accurate, minimal, and consistent with existing style.');
    expect(source).toContain(
      '**Success**: Review 7-day commits, update out-of-sync docs, verify examples, and create a clear PR summary.'
    );
    expect(source).toContain(
      'Ensure code examples in documentation match current CLI flags, environment variables, Docker configuration, and file paths.'
    );
    expect(source).not.toContain('### 0. Check For Changes First (Do This Before Anything Else)');
    expect(source).not.toContain("If `false`: call `safeoutputs noop` immediately and stop.");
    expect(source).not.toContain('Read `/tmp/gh-aw/doc-maintainer-context/changed-count.txt`.');
    expect(source).not.toContain('Do not expand review scope to `/tmp/gh-aw/doc-maintainer-context/doc-files.txt`.');
    expect(source).not.toContain('## Edge Cases');
    expect(source).not.toContain('A successful run means:');
    expect(source).not.toContain('## Context for This Run');
    expect(source).not.toContain('Review the broader list in `/tmp/gh-aw/doc-maintainer-context/doc-files.txt` only when there is a clear link to the recent source changes.');
  });

  it('compiles tool disabling into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('--max-turns 10');
    expect(lock).toContain('if: needs.check_relevant_changes.outputs.has_changes == \'true\'');
    expect(lock).toContain('Build documentation maintainer context');
    expect(lock).toContain('--patch --stat --unified=1');
    expect(lock).toContain('| grep -v \'^Binary\' | head -100 > \\"$CONTEXT_DIR/recent-diffs.txt\\"');
    expect(lock).toContain('head -10 > \\"$AFFECTED\\" || true');
    expect(lock).not.toContain('/tmp/gh-aw/doc-maintainer-context/has-changes.txt');
    expect(lock).not.toContain('/tmp/gh-aw/doc-maintainer-context/changed-count.txt');
    expect(lock).not.toContain('mcp__github');
  });
});
