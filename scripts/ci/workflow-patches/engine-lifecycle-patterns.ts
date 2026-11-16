// Work around gh-aw compiler bug (gh-aw#26565) where Copilot model selection is
// emitted at the step level for BYOK smoke workflows. Normalize every compiled
// step-level COPILOT_MODEL expression back to `${{ env.COPILOT_MODEL }}`.
export const copilotModelOverrideRegex =
  /^(\s*COPILOT_MODEL:\s*)\$\{\{\s*(?:vars\.GH_AW_MODEL_AGENT_COPILOT\s*\|\|\s*)?(?:vars\.GH_AW_DEFAULT_MODEL_COPILOT\s*\|\|\s*)?(?:env\.COPILOT_MODEL|''|'[^']*')\s*\}\}[ \t]*$/gm;

export function removeCopilotGithubCliPermission(workflow: string): string {
  return workflow.replace(" --allow-tool '\\''shell(github:*)'\\''", '');
}

// Matches the "Copy Copilot CLI to daemon-visible path" step that the gh-aw
// compiler emits for every firewall + arc-dind workflow regardless of the
// configured engine (gh-aw bug, github/gh-aw-firewall#7505). The step runs
// `command -v copilot` without a fallback and then `cp`s the result, so it
// fails the job for non-Copilot engines where the Copilot CLI is not installed.
export const copilotCliDaemonCopyStepRegex =
  /^(\s+)- name: Copy Copilot CLI to daemon-visible path\n\1  run: \|\n\1    mkdir -p "\$\{RUNNER_TEMP\}\/gh-aw\/bin"\n\1    COPILOT_SRC="\$\(command -v copilot\)"\n\1    cp "\$COPILOT_SRC" "\$\{RUNNER_TEMP\}\/gh-aw\/bin\/copilot"\n\1    chmod \+x "\$\{RUNNER_TEMP\}\/gh-aw\/bin\/copilot"\n/gm;
// Idempotency guard: present once the copy step has been rewritten by AWF
// postprocessing.
export const copilotCliDaemonCopyStepSentinel =
  '# AWF postprocess: Copilot CLI copy gated on compiled engine';
// Reads the compiled engine id out of a lock file. The compiler emits
// `GH_AW_ENGINE_ID: "<id>"` in job/step env blocks; shell exports of
// GH_AW_ENGINE do not persist across Actions steps, so the engine must be
// resolved at postprocess time rather than at runtime.
export const compiledEngineIdRegex = /^\s*GH_AW_ENGINE_ID:\s*"([^"]+)"\s*$/m;
