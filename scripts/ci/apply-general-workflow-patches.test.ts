import {
  applyGeneralWorkflowPatches,
  usesPublishedAwfRelease,
} from './apply-general-workflow-patches';
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

describe('applyGeneralWorkflowPatches published AWF maintenance workflows', () => {
  const compilerOutput =
    'jobs:\n' +
    '  agent:\n' +
    '    steps:\n' +
    '      - name: Install AWF binary\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.28.2\n' +
    '      - name: Run agent\n' +
    '        run: awf --image-tag 0.28.2 --skip-pull -- command\n';

  it.each([
    'auth-doctor-updater.lock.yml',
    'doc-maintainer.lock.yml',
    'model-api-mapping-updater.lock.yml',
    'sbx-gvisor-doc-updater.lock.yml',
    'schema-sync.lock.yml',
    'self-hosted-runner-doctor-updater.lock.yml',
    'update-release-notes.lock.yml',
  ])('preserves the published release for %s', workflowFile => {
    const workflowPath = `/tmp/workflows/${workflowFile}`;
    const { content, log } = applyGeneralWorkflowPatches(compilerOutput, workflowPath);

    expect(usesPublishedAwfRelease(workflowPath)).toBe(true);
    expect(content).toContain('install_awf_binary.sh" v0.28.2');
    expect(content).toContain('--image-tag 0.28.2 --skip-pull');
    expect(content).not.toContain('--build-local');
    expect(log).toContain('  Preserved published AWF binary and images for maintenance workflow');
  });

  it('continues using local builds for validation workflows', () => {
    const { content } = applyGeneralWorkflowPatches(
      compilerOutput,
      '/tmp/workflows/smoke-copilot.lock.yml'
    );

    expect(content).toContain('Install awf binary (local)');
    expect(content).toContain('--build-local');
    expect(content).not.toContain('--image-tag 0.28.2 --skip-pull');
  });
});
