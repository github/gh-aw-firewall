import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'doc-maintainer.md');
const lockPath = path.join(workflowsDir, 'doc-maintainer.lock.yml');

describe('doc maintainer workflow optimization config', () => {
  it('disables unused tools and keeps condensed prompt sections in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('description: Daily documentation review with a 7-day change gate and 48-hour agent context');
    expect(source).toContain("if: needs.check_relevant_changes.outputs.has_changes == 'true' && needs.check_relevant_changes.outputs.skip_agent != 'true'");
    expect(source).toContain('max-turns: 15');
    expect(source).toContain('bash: false');
    expect(source).toContain('github: false');
    expect(source).toContain('Read `/tmp/gh-aw/doc-maintainer-context/context.md` first.');
    expect(source).toContain('Use the **Recent Git Diffs** section from that file as your **sole source**');
    expect(source).toContain('**Do not use the `shell` tool** (and the `bash` tool is disabled). Do not attempt to run `git`, `npm test`, `ls`, or any other shell command');
    expect(source).toContain('The workflow gate already checked the past 7 days to decide whether this run is needed.');
    expect(source).toContain('files listed under **Affected Documentation** in `/tmp/gh-aw/doc-maintainer-context/context.md`');
    expect(source).toContain('echo "## Changes"');
    expect(source).toContain('echo "## Affected Documentation"');
    expect(source).toContain('echo "## Recent Git Diffs"');
    expect(source).toContain("git log --since=\"7 days ago\" --format=\"=== Commit %H: %s ===\" --stat -- src/ containers/ scripts/ docs/ '*.md' | head -30");
    expect(source).toContain("git log --since=\"48 hours ago\" --format=\"=== Commit %H: %s ===\" --stat -- src/ containers/ scripts/ docs/ '*.md' | head -20");
    expect(source).toContain('skip_agent: ${{ steps.check.outputs.skip_agent }}');
    expect(source).toContain('DIFF_LINES=$(wc -l < "$DIFF_PREVIEW" | tr -d \' \')');
    expect(source).toContain('if [ "$HAS_CHANGES" = "true" ] && [ "$DIFF_LINES" -lt 3 ]; then');
    expect(source).toContain('echo "::warning::Recent diffs are minimal ($DIFF_LINES lines, $DIFF_BYTES bytes). Skipping agent run."');
    expect(source).not.toContain('No markdown/docs changes in 7 days. Skipping documentation review.');
    expect(source).toContain('echo "Context size: ${CONTEXT_SIZE} bytes"');
    expect(source).toContain('echo "Diff lines: ${DIFF_LINES}"');
    expect(source).toContain('echo "::warning::Context file is empty or minimal ($CONTEXT_SIZE bytes). Skipping agent run."');
    expect(source).toContain('echo "skip_agent=true" >> "$GITHUB_OUTPUT"');
    expect(source).toContain("grep -i -F -f \"$TOKENS\" \"$DOC_POOL\" | head -3 > \"$AFFECTED\" || true");
    expect(source).toContain('## Affected Documentation Content (pre-loaded — do not re-read these files)');
    expect(source).toContain('The first 40 lines of up to 3 affected documentation files are pre-loaded');
    expect(source).not.toContain('## Guidelines');
    expect(source).toContain(
      '**PR Description**: Summarize updated docs, reference the triggering code changes, and list what was verified.'
    );
    expect(source).toContain(
      '**Success**: Review the 48-hour commit context after the 7-day gate fires, update out-of-sync docs, verify examples, and create a clear PR summary.'
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

    expect(lock).toContain('# Daily documentation review with a 7-day change gate and 48-hour agent context');
    expect(lock).toContain('GH_AW_MAX_TURNS: 15');
    expect(lock).toContain("(needs.check_relevant_changes.outputs.has_changes == 'true' && needs.check_relevant_changes.outputs.skip_agent != 'true')");
    expect(lock).toContain('Build documentation maintainer context');
    expect(lock).toContain('skip_agent: ${{ steps.check.outputs.skip_agent }}');
    expect(lock).toContain('--stat -- src/ containers/ scripts/ docs/ \'*.md\' | head -30');
    expect(lock).toContain('--since=\\"48 hours ago\\" --format=\\"=== Commit %H: %s ===\\" --stat -- src/ containers/ scripts/ docs/ \'*.md\' | head -20');
    expect(lock).toContain('head -3 > \\"$AFFECTED\\" || true');
    expect(lock).not.toContain('No markdown/docs changes in 7 days. Skipping documentation review.');
    expect(lock).not.toContain('/tmp/gh-aw/doc-maintainer-context/has-changes.txt');
    expect(lock).not.toContain('/tmp/gh-aw/doc-maintainer-context/changed-count.txt');
    expect(lock).not.toContain('mcp__github');
  });
});
