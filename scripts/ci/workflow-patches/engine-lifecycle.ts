import type { PatchContext, TransformResult } from './types';
import {
  copilotCliDaemonCopyStepRegex, copilotCliDaemonCopyStepSentinel,
  compiledEngineIdRegex, copilotModelOverrideRegex,
} from './engine-lifecycle-patterns';
import { buildCopilotCliDaemonCopyStep } from '../workflow-step-builders';

export function retryCopilotInstall(content: string, { workflowFile }: PatchContext): TransformResult {
  const messages: string[] = [];
  if (
    workflowFile === 'copilot-token-optimizer.lock.yml' ||
    workflowFile === 'dependency-security-monitor.lock.yml'
  ) {
    const copilotInstallStep =
      /^([ \t]+)- name: Install GitHub Copilot CLI\n\1  run: (bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/install_copilot_cli\.sh" [^\n]+)\n/m;
    if (copilotInstallStep.test(content)) {
      content = content.replace(
        copilotInstallStep,
        (_match, indent: string, command: string) =>
          `${indent}- name: Install GitHub Copilot CLI\n` +
          `${indent}  timeout-minutes: 7\n` +
          `${indent}  run: |\n` +
          `${indent}    for attempt in 1 2 3; do\n` +
          `${indent}      install_status=0\n` +
          `${indent}      timeout --kill-after=10s 90s ${command} || install_status=$?\n` +
          `${indent}      if [ "$install_status" -eq 0 ]; then\n` +
          `${indent}        exit 0\n` +
          `${indent}      fi\n` +
          `${indent}      # Retry curl download failures, never verification or installation errors.\n` +
          `${indent}      case "$install_status" in\n` +
          `${indent}        5|6|7|18|22|28|35|52|55|56) ;;\n` +
          `${indent}        *) exit "$install_status" ;;\n` +
          `${indent}      esac\n` +
          `${indent}      if [ "$attempt" -eq 3 ]; then\n` +
          `${indent}        exit "$install_status"\n` +
          `${indent}      fi\n` +
          `${indent}      echo "Copilot CLI download failed (exit $install_status); retrying after attempt $attempt" >&2\n` +
          `${indent}      sleep $((attempt * 30))\n` +
          `${indent}    done\n`,
      );
      messages.push(`  Added bounded Copilot CLI download retries for ${workflowFile}`);
    }
  }
  return { content, messages };
}

export function gateEngineLifecycle(content: string): TransformResult {
  const messages: string[] = [];
  // Codex ships a prebuilt binary; Claude needs its native-binary postinstall.
  content = content.replace(
    /^([ \t]*run: npm install )(?![^\n]*--ignore-scripts)([^\n]*@openai\/codex@[^\n]*)$/gm,
    '$1--ignore-scripts $2',
  );
  if (!content.includes(copilotCliDaemonCopyStepSentinel)) {
    copilotCliDaemonCopyStepRegex.lastIndex = 0;
    const copilotCliCopyMatches = content.match(copilotCliDaemonCopyStepRegex);
    if (copilotCliCopyMatches) {
      const engineId = content.match(compiledEngineIdRegex)?.[1] ?? 'copilot';
      content = content.replace(copilotCliDaemonCopyStepRegex, (_match, indent: string) =>
        buildCopilotCliDaemonCopyStep(indent, engineId)
      );
      messages.push(
        `  Gated ${copilotCliCopyMatches.length} 'Copy Copilot CLI to daemon-visible path' ` +
          `step(s) on compiled engine '${engineId}'`
      );
    }
  } else {
    messages.push(`  'Copy Copilot CLI to daemon-visible path' step already engine-gated`);
  }
  return { content, messages };
}

export function configureCopilotToolsAndModel(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const isCopilotSmoke = workflowPath.includes('smoke-copilot.lock.yml');
  if (isCopilotSmoke) {
    const excludedToolsFlag =
      '--excluded-tools=browser_close,browser_resize,browser_console_messages,' +
      'browser_handle_dialog,browser_evaluate,browser_file_upload,browser_fill_form,' +
      'browser_press_key,browser_type,browser_navigate,browser_navigate_back,' +
      'browser_network_requests,browser_run_code,browser_take_screenshot,' +
      'browser_snapshot,browser_click,browser_drag,browser_hover,' +
      'browser_select_option,browser_tabs,browser_wait_for';
    const existingExcludedRegex = / --excluded-tools=[^\s'"]*/g;
    const existingMatches = content.match(existingExcludedRegex);
    if (existingMatches) {
      content = content.replace(existingExcludedRegex, '');
      messages.push(`  Removed ${existingMatches.length} existing --excluded-tools flag(s)`);
    }
    const allowAllToolsCount = (content.match(/--allow-all-tools/g) || []).length;
    if (allowAllToolsCount > 0) {
      content = content.replace(
        /--allow-all-tools/g,
        `--allow-all-tools ${excludedToolsFlag}`
      );
      messages.push(`  Injected --excluded-tools (21 browser tools) in ${allowAllToolsCount} location(s)`);
    }
  }
  const isCopilotByokSmoke = /smoke-copilot-byok[^/]*\.lock\.yml$/.test(workflowPath);
  if (isCopilotByokSmoke) {
    const rewrittenContent = content.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    if (rewrittenContent !== content) {
      const rewrittenCount = (content.match(copilotModelOverrideRegex) || []).length;
      content = rewrittenContent;
      messages.push(
        `  Rewrote ${rewrittenCount} COPILOT_MODEL override(s) to env.COPILOT_MODEL for BYOK smoke`
      );
    }
  }
  return { content, messages };
}
