import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';
import { copilotCliDaemonCopyStepSentinel } from './workflow-patch-patterns';

// The gh-aw compiler emits this step for every firewall + arc-dind workflow
// regardless of engine.id (github/gh-aw-firewall#7505), so for non-Copilot
// engines `command -v copilot` resolves empty and the `cp` fails the job.
const COMPILER_EMITTED_COPY_STEP =
  '      - name: Copy Copilot CLI to daemon-visible path\n' +
  '        run: |\n' +
  '          mkdir -p "${RUNNER_TEMP}/gh-aw/bin"\n' +
  '          COPILOT_SRC="$(command -v copilot)"\n' +
  '          cp "$COPILOT_SRC" "${RUNNER_TEMP}/gh-aw/bin/copilot"\n' +
  '          chmod +x "${RUNNER_TEMP}/gh-aw/bin/copilot"\n';

function lockFileWithEngine(engineId: string): string {
  return (
    'jobs:\n' +
    '  agent:\n' +
    '    env:\n' +
    `      GH_AW_ENGINE_ID: "${engineId}"\n` +
    '    steps:\n' +
    COMPILER_EMITTED_COPY_STEP
  );
}

describe('applyGeneralWorkflowPatches Copilot CLI copy step gating', () => {
  it('skips the copy for a non-copilot compiled engine', () => {
    const { content, log } = applyGeneralWorkflowPatches(
      lockFileWithEngine('claude'),
      '/tmp/example.lock.yml'
    );

    expect(content).toContain(copilotCliDaemonCopyStepSentinel);
    expect(content).toContain(
      'echo "Skipping Copilot CLI binary copy for non-copilot engine: claude" >&2'
    );
    expect(content).not.toContain('command -v copilot');
    expect(log.some(entry => entry.includes("compiled engine 'claude'"))).toBe(true);
  });

  it('keeps fail-fast copy behaviour for the copilot engine', () => {
    const { content } = applyGeneralWorkflowPatches(
      lockFileWithEngine('copilot'),
      '/tmp/example.lock.yml'
    );

    expect(content).toContain('COPILOT_SRC="$(command -v copilot 2>/dev/null || true)"');
    expect(content).toContain('exit 127');
    expect(content).toContain('cp "$COPILOT_SRC" "${RUNNER_TEMP}/gh-aw/bin/copilot"');
  });

  it('defaults to copilot when no engine id is present', () => {
    const { content } = applyGeneralWorkflowPatches(
      COMPILER_EMITTED_COPY_STEP,
      '/tmp/example.lock.yml'
    );

    expect(content).toContain('exit 127');
  });

  it('is idempotent across repeated postprocess runs', () => {
    const first = applyGeneralWorkflowPatches(lockFileWithEngine('claude'), '/tmp/example.lock.yml');
    const second = applyGeneralWorkflowPatches(first.content, '/tmp/example.lock.yml');
    expect(second.content).toBe(first.content);
  });
});
