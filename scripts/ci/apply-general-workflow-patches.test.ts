import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

describe('applyGeneralWorkflowPatches copilot copy guard', () => {
  const strictCopilotCopyBlock =
    '          GH_AW_COPILOT_SRC="$(command -v copilot 2>/dev/null || true)"\n' +
    '          if [ -z "$GH_AW_COPILOT_SRC" ] || [ ! -x "$GH_AW_COPILOT_SRC" ]; then\n' +
    '            echo "GitHub Copilot CLI executable not found on PATH after installation" >&2\n' +
    '            exit 127\n' +
    '          fi\n' +
    '          GH_AW_COPILOT_BIN="${RUNNER_TEMP}/gh-aw/bin/copilot"\n' +
    '          mkdir -p "${RUNNER_TEMP}/gh-aw/bin"\n' +
    '          if [ "$GH_AW_COPILOT_SRC" != "$GH_AW_COPILOT_BIN" ]; then\n' +
    '            cp "$GH_AW_COPILOT_SRC" "$GH_AW_COPILOT_BIN"\n' +
    '          fi\n' +
    '          chmod 755 "$GH_AW_COPILOT_BIN"\n';

  it('rewrites strict copy block to be engine-gated', () => {
    const { content, log } = applyGeneralWorkflowPatches(
      strictCopilotCopyBlock,
      '/tmp/example.lock.yml'
    );

    expect(content).toContain('if [ "${GH_AW_ENGINE:-copilot}" != "copilot" ]; then');
    expect(content).toContain(
      'Skipping Copilot CLI binary copy for non-copilot engine: ${GH_AW_ENGINE:-unset}'
    );
    expect(content).toMatch(/else\n\s+GH_AW_COPILOT_SRC="\$\(command -v copilot 2>\/dev\/null \|\| true\)"/);
    expect(content).toContain('exit 127');
    expect(log.some(entry => entry.includes('Engine-gated'))).toBe(true);
  });

  it('is idempotent after rewrite', () => {
    const first = applyGeneralWorkflowPatches(strictCopilotCopyBlock, '/tmp/example.lock.yml');
    const second = applyGeneralWorkflowPatches(first.content, '/tmp/example.lock.yml');
    expect(second.content).toBe(first.content);
  });
});
