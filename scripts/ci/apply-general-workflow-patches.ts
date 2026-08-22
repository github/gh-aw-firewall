// Applies general (non-Codex-specific) transformations to a compiled lock file.
// Returns the (possibly modified) content and a list of log messages; callers
// are responsible for writing the file and printing the messages.

import {
  installStepRegexGlobal,
  duplicateSetupNodeRegex,
  sparseCheckoutRegex,
  shallowDepthRegex,
  imageTagRegex,
  standaloneSkipPullRegex,
  localAwfImageDownloadRegex,
  sessionStateDirInjectionRegex,
  SESSION_STATE_DIR,
  legacyApiProxyLogsDirRegex,
  copilotModelOverrideRegex,
  copySessionStateSentinel,
  copySessionStateStepRegex,
  copilotCliDaemonCopyStepRegex,
  copilotCliDaemonCopyStepSentinel,
  compiledEngineIdRegex,
  updateCacheSetupScriptRegex,
  setupCacheMemoryStepRegex,
  stripExecBitsStepSentinel,
  cacheMemoryCommitStepRegex,
  scanInjectionStepSentinel,
  createCacheDirStepRegex,
  cacheDateStepSentinel,
  cacheMemoryKeyLineRegex,
  cacheRestoreKeyPrefixRegex,
  cacheDateRestoreKeySentinel,
  issueDuplicationConclusionConcurrencyRegex,
  issueDuplicationConclusionConcurrencySentinel,
  ripgrepInstallStepRegex,
} from './workflow-patch-patterns';
import {
  buildLocalInstallSteps,
  buildCopySessionStateStep,
  buildCopilotCliDaemonCopyStep,
  buildStripExecBitsStep,
  buildScanInjectionStep,
  buildCacheDateStep,
} from './workflow-step-builders';

export interface PatchResult {
  content: string;
  log: string[];
}

const publishedAwfWorkflowLockFiles = new Set([
  'auth-doctor-updater.lock.yml',
  'doc-maintainer.lock.yml',
  'model-api-mapping-updater.lock.yml',
  'sbx-gvisor-doc-updater.lock.yml',
  'schema-sync.lock.yml',
  'self-hosted-runner-doctor-updater.lock.yml',
  'update-release-notes.lock.yml',
]);

export function usesPublishedAwfRelease(workflowPath: string): boolean {
  const workflowFile = workflowPath.split(/[/\\]/).pop();
  return workflowFile !== undefined && publishedAwfWorkflowLockFiles.has(workflowFile);
}

// Applies all general-purpose transforms to a single workflow lock file.
// `workflowPath` is used only for file-specific conditional transforms
// (issue-duplication-detector, smoke-copilot, smoke-copilot-byok variants).
export function applyGeneralWorkflowPatches(
  content: string,
  workflowPath: string
): PatchResult {
  const log: string[] = [];

  // Bound the generated installer in smoke workflows and the build-test workflow.
  // install_ripgrep.sh uses apt-get update -qq without its own timeout, so a bad
  // hosted-runner mirror otherwise leaves the whole agent job running for hours.
  const shouldBoundRipgrepInstall =
    /(?:^|[/\\])smoke-[^/\\]+\.lock\.yml$/.test(workflowPath) ||
    workflowPath.endsWith('build-test.lock.yml');
  if (shouldBoundRipgrepInstall) {
    ripgrepInstallStepRegex.lastIndex = 0;
    const ripgrepInstallMatches = content.match(ripgrepInstallStepRegex);
    if (ripgrepInstallMatches) {
      content = content.replace(
        ripgrepInstallStepRegex,
        (_match, indent: string) =>
          `${indent}- name: Install ripgrep\n` +
          `${indent}  timeout-minutes: 5\n` +
          `${indent}  run: timeout --foreground --kill-after=10s 4m bash "\${RUNNER_TEMP}/gh-aw/actions/install_ripgrep.sh"\n`
      );
      log.push(`  Bounded ${ripgrepInstallMatches.length} ripgrep install step(s)`);
    }
  }

  // The enclave backend starts inside AWF, after mcpg. Keep it in the agent's
  // gateway config but exempt it from the eager startup connectivity check so
  // mcpg can rediscover it once AWF attaches and launches the backend.
  if (workflowPath.endsWith('smoke-enclave-build-test.lock.yml')) {
    const optionalEnclaveServer = '"awf-enclave": {\n                "required": false,';
    if (content.includes(optionalEnclaveServer)) {
      log.push(`  Enclave MCP backend already marked optional during gateway startup`);
    } else {
      const enclaveServerAnchor = '"awf-enclave": {\n                "type": "http",';
      if (!content.includes(enclaveServerAnchor)) {
        throw new Error('Could not find the enclave MCP backend in the compiled smoke workflow');
      }
      content = content.replace(
        enclaveServerAnchor,
        '"awf-enclave": {\n                "required": false,\n                "type": "http",'
      );
      log.push(`  Marked enclave MCP backend optional during gateway startup`);
    }

    const gatewayKeyEnv =
      '          MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}';
    const agentEnvAnchor = '        env:\n          AWF_REFLECT_ENABLED: 1';
    if (content.includes(`${gatewayKeyEnv}\n          AWF_REFLECT_ENABLED: 1`)) {
      log.push(`  Gateway API key already available to AWF readiness checks`);
    } else {
      if (!content.includes(agentEnvAnchor)) {
        throw new Error('Could not find the enclave smoke agent environment');
      }
      content = content.replace(
        agentEnvAnchor,
        `        env:\n${gatewayKeyEnv}\n          AWF_REFLECT_ENABLED: 1`
      );
      log.push(`  Exposed gateway API key to AWF readiness checks`);
    }
  }

  if (usesPublishedAwfRelease(workflowPath)) {
    log.push(`  Preserved published AWF binary and images for maintenance workflow`);
  } else {
    // Replace "Install awf binary" step with local build steps
    // Reset global regex state before reuse across multiple files.
    installStepRegexGlobal.lastIndex = 0;
    const matches = content.match(installStepRegexGlobal);
    if (matches) {
      content = content.replace(
        installStepRegexGlobal,
        (_match, indent: string) => buildLocalInstallSteps(indent)
      );
      log.push(`  Replaced ${matches.length} awf install step(s) with local build`);
    }

    // Collapse a duplicate "Setup Node.js" step: buildLocalInstallSteps injects a
    // Setup Node.js step (needed for workflows the compiler leaves without one), but
    // some workflows already emit an identical Setup Node.js immediately before the
    // install step, producing two consecutive identical steps. The backreference only
    // matches byte-identical consecutive blocks, so this never removes a differing or
    // required step. Loop until stable in case of >2 repeats.
    while (duplicateSetupNodeRegex.test(content)) {
      content = content.replace(duplicateSetupNodeRegex, '$1');
      log.push(`  Collapsed duplicate consecutive Setup Node.js step`);
    }

    // Ensure a "Checkout repository" step exists before "Install awf dependencies"
    // in every job. The gh-aw compiler may add jobs (e.g. detection) that reference
    // install_awf_binary.sh but don't include a checkout step. After we replace the
    // install step with local build steps (npm ci / npm run build), they need the
    // repo checked out. We inject a checkout step right before "Install awf dependencies"
    // if one doesn't already appear earlier in the same job.
    const lines = content.split('\n');
    let injectedCheckouts = 0;
    for (let i = 0; i < lines.length; i++) {
      const installMatch = lines[i].match(/^(\s+)- name: Install awf dependencies$/);
      if (!installMatch) continue;

      // Walk backwards to find the job boundary (non-indented key ending with ':')
      // and check whether an *unconditional* "Checkout repository" step exists in
      // between. Conditional checkouts (e.g. "Checkout repository for patch context"
      // with an `if:` guard) don't guarantee the repo is available, so we still
      // need to inject one.
      let hasCheckout = false;
      for (let j = i - 1; j >= 0; j--) {
        if (/^\s+- name: Checkout repository/.test(lines[j])) {
          // Check if this checkout step has an `if:` condition (next line)
          const nextLine = j + 1 < lines.length ? lines[j + 1] : '';
          if (/^\s+if:/.test(nextLine)) {
            // Conditional checkout — doesn't count, keep searching
            continue;
          }
          hasCheckout = true;
          break;
        }
        // Job-level key (e.g. "  agent:" or "  detection:") marks the boundary
        if (/^  \S+:/.test(lines[j]) && !lines[j].startsWith('    ')) {
          break;
        }
      }

      if (!hasCheckout) {
        const indent = installMatch[1];
        const checkoutStep = [
          `${indent}- name: Checkout repository`,
          `${indent}  uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`,
          `${indent}  with:`,
          `${indent}    persist-credentials: false`,
        ].join('\n');
        lines.splice(i, 0, checkoutStep);
        injectedCheckouts++;
        i += 4; // Skip past the inserted lines
      }
    }
    if (injectedCheckouts > 0) {
      content = lines.join('\n');
      log.push(`  Injected ${injectedCheckouts} checkout step(s) before awf build steps`);
    }

    // Remove sparse-checkout from agent job checkout (need full repo for npm build)
    const sparseMatches = content.match(sparseCheckoutRegex);
    if (sparseMatches) {
      content = content.replace(sparseCheckoutRegex, '');
      log.push(`  Removed ${sparseMatches.length} sparse-checkout block(s)`);
    }

    // Remove shallow depth (depth: 1) since full checkout is needed
    const depthMatches = content.match(shallowDepthRegex);
    if (depthMatches) {
      content = content.replace(shallowDepthRegex, '');
      log.push(`  Removed ${depthMatches.length} shallow depth setting(s)`);
    }

    // Replace GHCR image tags with local builds
    const imageTagMatches = content.match(imageTagRegex);
    if (imageTagMatches) {
      content = content.replace(imageTagRegex, '--build-local');
      log.push(`  Replaced ${imageTagMatches.length} --image-tag/--skip-pull with --build-local`);
    }

    // Replace standalone --skip-pull, including an incompatible generated
    // "--skip-pull --build-local" pair, with one local-build flag.
    standaloneSkipPullRegex.lastIndex = 0;
    const skipPullMatches = content.match(standaloneSkipPullRegex);
    if (skipPullMatches) {
      content = content.replace(standaloneSkipPullRegex, '--build-local');
      log.push(`  Replaced ${skipPullMatches.length} standalone --skip-pull with --build-local`);
    }

    // The compiler's eager image-download step runs before the local AWF build.
    // Remove only AWF's unreleased images; digest-pinned tool images still pull.
    if (content.includes('--build-local')) {
      localAwfImageDownloadRegex.lastIndex = 0;
      const localAwfImageMatches = content.match(localAwfImageDownloadRegex);
      if (localAwfImageMatches) {
        content = content.replace(localAwfImageDownloadRegex, '');
        log.push(`  Removed ${localAwfImageMatches.length} local AWF image download(s)`);
      }
    }
  }

  // Inject --session-state-dir into AWF invocations so Copilot CLI session-state
  // (events.jsonl) is written to a predictable host path accessible for artifact
  // upload. The negative lookahead in the regex ensures idempotency.
  sessionStateDirInjectionRegex.lastIndex = 0;
  const sessionStateDirMatches = content.match(sessionStateDirInjectionRegex);
  if (sessionStateDirMatches) {
    content = content.replace(
      sessionStateDirInjectionRegex,
      `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
    );
    log.push(
      `  Injected --session-state-dir in ${sessionStateDirMatches.length} awf invocation(s)`
    );
  } else {
    log.push(`  --session-state-dir already present (or no awf invocation found)`);
  }

  // Normalize legacy api-proxy log directory paths to the current logs folder.
  const legacyApiProxyLogDirMatches = content.match(legacyApiProxyLogsDirRegex);
  if (legacyApiProxyLogDirMatches) {
    content = content.replace(
      legacyApiProxyLogsDirRegex,
      '/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs'
    );
    log.push(
      `  Updated ${legacyApiProxyLogDirMatches.length} legacy api-proxy log path reference(s)`
    );
  }

  // Claude Code: no --ignore-scripts injection (needs postinstall for native binary)

  // Replace the "Copy Copilot session state files to logs" step with an inline
  // script that reads from the AWF-managed session-state path instead of
  // $HOME/.copilot/session-state (which is empty when Copilot CLI ran inside
  // the AWF Docker container).
  if (!content.includes(copySessionStateSentinel)) {
    const copyMatch = content.match(copySessionStateStepRegex);
    if (copyMatch) {
      const indent = copyMatch[1];
      content = content.replace(copySessionStateStepRegex, buildCopySessionStateStep(indent));
      log.push(`  Replaced 'Copy Copilot session state' step with AWF-path inline script`);
    }
  } else {
    log.push(`  'Copy Copilot session state' step already updated`);
  }

  // Rewrite the compiler-emitted "Copy Copilot CLI to daemon-visible path"
  // step (firewall + arc-dind) so it is gated on the compiled engine. gh-aw
  // emits this step for every engine, but only the Copilot engine installs the
  // `copilot` binary, so other engines fail on `command -v copilot` + `cp`.
  // The engine is resolved from the lock file (GH_AW_ENGINE_ID) because shell
  // exports of GH_AW_ENGINE do not persist across Actions steps.
  if (!content.includes(copilotCliDaemonCopyStepSentinel)) {
    copilotCliDaemonCopyStepRegex.lastIndex = 0;
    const copilotCliCopyMatches = content.match(copilotCliDaemonCopyStepRegex);
    if (copilotCliCopyMatches) {
      const engineId = content.match(compiledEngineIdRegex)?.[1] ?? 'copilot';
      content = content.replace(copilotCliDaemonCopyStepRegex, (_match, indent: string) =>
        buildCopilotCliDaemonCopyStep(indent, engineId)
      );
      log.push(
        `  Gated ${copilotCliCopyMatches.length} 'Copy Copilot CLI to daemon-visible path' ` +
          `step(s) on compiled engine '${engineId}'`
      );
    }
  } else {
    log.push(`  'Copy Copilot CLI to daemon-visible path' step already engine-gated`);
  }

  // For issue-duplication-detector: scope the conclusion job's concurrency
  // group to the triggering issue number so that concurrent runs for different
  // issues don't block each other's conclusion jobs.
  const isIssueDuplicationDetector = workflowPath.includes(
    'issue-duplication-detector.lock.yml'
  );
  if (isIssueDuplicationDetector) {
    if (!content.includes(issueDuplicationConclusionConcurrencySentinel)) {
      const concMatch = content.match(issueDuplicationConclusionConcurrencyRegex);
      if (concMatch) {
        content = content.replace(
          issueDuplicationConclusionConcurrencyRegex,
          `$1-\${{ github.event.issue.number || github.run_id }}$2`
        );
        log.push(`  Scoped conclusion concurrency group to per-issue for issue-duplication-detector`);
      } else {
        log.push(
          `  WARNING: Could not find conclusion concurrency group in issue-duplication-detector. ` +
            `The compiled lock file may have changed structure. Manual review required.`
        );
      }
    } else {
      log.push(`  Conclusion concurrency group already per-issue for issue-duplication-detector`);
    }
  }

  // Exclude unused Playwright/browser tools from Copilot CLI for smoke-copilot.
  // The Copilot CLI includes 21 built-in browser_* tools when --allow-all-tools is set.
  // These tools are never used in smoke-copilot but add ~10,500 tokens/turn of dead weight.
  const isCopilotSmoke = workflowPath.includes('smoke-copilot.lock.yml');
  if (isCopilotSmoke) {
    const excludedToolsFlag =
      '--excluded-tools=browser_close,browser_resize,browser_console_messages,' +
      'browser_handle_dialog,browser_evaluate,browser_file_upload,browser_fill_form,' +
      'browser_press_key,browser_type,browser_navigate,browser_navigate_back,' +
      'browser_network_requests,browser_run_code,browser_take_screenshot,' +
      'browser_snapshot,browser_click,browser_drag,browser_hover,' +
      'browser_select_option,browser_tabs,browser_wait_for';
    // First, strip any existing --excluded-tools flag to make this idempotent
    const existingExcludedRegex = / --excluded-tools=[^\s'"]*/g;
    const existingMatches = content.match(existingExcludedRegex);
    if (existingMatches) {
      content = content.replace(existingExcludedRegex, '');
      log.push(`  Removed ${existingMatches.length} existing --excluded-tools flag(s)`);
    }
    const allowAllToolsCount = (content.match(/--allow-all-tools/g) || []).length;
    if (allowAllToolsCount > 0) {
      content = content.replace(
        /--allow-all-tools/g,
        `--allow-all-tools ${excludedToolsFlag}`
      );
      log.push(`  Injected --excluded-tools (21 browser tools) in ${allowAllToolsCount} location(s)`);
    }
  }

  // For smoke-copilot-byok variants: replace compiled COPILOT_MODEL override
  // expressions with the workflow-level COPILOT_MODEL env so the generated
  // step inherits the intended BYOK model instead of any repo-level default.
  const isCopilotByokSmoke = /smoke-copilot-byok[^/]*\.lock\.yml$/.test(workflowPath);
  if (isCopilotByokSmoke) {
    const rewrittenContent = content.replace(
      copilotModelOverrideRegex,
      '$1${{ env.COPILOT_MODEL }}'
    );
    if (rewrittenContent !== content) {
      const rewrittenCount = (content.match(copilotModelOverrideRegex) || []).length;
      content = rewrittenContent;
      log.push(
        `  Rewrote ${rewrittenCount} COPILOT_MODEL override(s) to env.COPILOT_MODEL for BYOK smoke`
      );
    }
  }

  // gh-aw v0.87.0 supplies the Azure OIDC IDs to the AWF invocation but no
  // longer emits their exclusions from --env-all. Keep these runner-only
  // authentication values out of the agent container.
  const isCopilotByokAoaiEntraSmoke = workflowPath.endsWith(
    'smoke-copilot-byok-aoai-entra.lock.yml'
  );
  if (isCopilotByokAoaiEntraSmoke) {
    const oidcExclusions =
      '--exclude-env ACTIONS_ID_TOKEN_REQUEST_TOKEN --exclude-env ACTIONS_ID_TOKEN_REQUEST_URL';
    const azureExclusions =
      ' --exclude-env AWF_AUTH_AZURE_CLIENT_ID --exclude-env AWF_AUTH_AZURE_TENANT_ID';
    if (!content.includes('--exclude-env AWF_AUTH_AZURE_CLIENT_ID')) {
      if (content.includes(oidcExclusions)) {
        content = content.replace(oidcExclusions, oidcExclusions + azureExclusions);
        log.push(`  Restored Azure OIDC environment exclusions from the AWF invocation`);
      } else {
        log.push(`  WARNING: Could not find OIDC environment exclusions for Azure OIDC protection`);
      }
    } else {
      log.push(`  Azure OIDC environment exclusions already present`);
    }
  }

  // NOTE: smoke-services no longer needs post-processing to add its Redis/PostgreSQL
  // service containers or host-service-port access. gh-aw v0.82+ natively supports a
  // top-level `services:` frontmatter section.

  // The step downloads a private action but is never used in update_cache_memory jobs,
  // causing 401 Unauthorized failures when permissions: {} is set.
  const updateCacheSetupMatches = content.match(updateCacheSetupScriptRegex);
  if (updateCacheSetupMatches) {
    content = content.replace(updateCacheSetupScriptRegex, '$2');
    log.push(
      `  Removed ${updateCacheSetupMatches.length} unused Setup Scripts step(s) from update_cache_memory`
    );
  }

  // ── Cache-memory security hardening ─────────────────────────────────────
  // Fix for execute-bit persistence and instruction-injection across cache
  // restore cycles (issue: cache-memory pipeline integrity at none integrity).
  //
  // 1. Inject "Strip execute bits" step after "Setup cache-memory git repository"
  // 2. Inject "Scan cache-memory for instruction-injection content" step before
  //    "Commit cache-memory changes"
  // 3. Inject "Compute cache-memory TTL date key" step before the cache action
  //    and update restore-keys to include the date for a 1-day TTL.

  // (1) Strip execute bits after cache-memory git setup
  if (!content.includes(stripExecBitsStepSentinel)) {
    const setupMatch = content.match(setupCacheMemoryStepRegex);
    if (setupMatch) {
      const indent = setupMatch[1];
      content = content.replace(
        setupCacheMemoryStepRegex,
        (m) => m + buildStripExecBitsStep(indent)
      );
      log.push(`  Injected 'Strip execute bits' step after cache-memory setup`);
    }
  } else {
    log.push(`  'Strip execute bits' step already present`);
  }

  // (2) Scan for instruction-injection content before cache-memory commit.
  // The scan step content has been updated to use quarantine-based handling
  // (moving files to .quarantine/ instead of deleting them) and a tighter
  // injection pattern (requires colons, e.g. 'SYSTEM:' not just 'SYSTEM').
  // The 'QUARANTINE_DIR' string acts as a sentinel for the new version.
  const scanStepNewVersion = 'QUARANTINE_DIR';
  if (!content.includes(scanInjectionStepSentinel)) {
    const commitMatch = content.match(cacheMemoryCommitStepRegex);
    if (commitMatch) {
      const indent = commitMatch[1];
      content = content.replace(
        cacheMemoryCommitStepRegex,
        (m) => buildScanInjectionStep(indent) + m
      );
      log.push(`  Injected 'Scan cache-memory for instruction-injection' step before commit`);
    }
  } else if (!content.includes(scanStepNewVersion)) {
    // Old version of the scan step is present — replace it with the new version.
    const oldScanStepRegex =
      /^(\s+)- name: Scan cache-memory for instruction-injection content\n(?:\1\s[^\n]*\n)+/m;
    const oldMatch = content.match(oldScanStepRegex);
    if (oldMatch) {
      const indent = oldMatch[1];
      content = content.replace(oldScanStepRegex, buildScanInjectionStep(indent));
      log.push(`  Updated 'Scan cache-memory for instruction-injection' step to new version`);
    }
  } else {
    log.push(`  'Scan cache-memory for instruction-injection' step already present (new version)`);
  }

  // (3) Add TTL date key step and update key/restore-keys to include daily date
  if (!content.includes(cacheDateStepSentinel)) {
    const createCacheMatch = content.match(createCacheDirStepRegex);
    if (createCacheMatch) {
      const indent = createCacheMatch[1];
      content = content.replace(
        createCacheDirStepRegex,
        (_m, ind, createStep, cacheStep) =>
          ind + createStep + buildCacheDateStep(ind) + cacheStep
      );
      log.push(`  Injected 'Compute cache-memory TTL date key' step before cache action`);
    }
  } else {
    log.push(`  'Compute cache-memory TTL date key' step already present`);
  }

  // Update the main cache key lines and restore-keys prefix to include the date
  // for a 1-day TTL. Apply each transformation independently so partially
  // updated workflows are repaired correctly and repeated runs stay idempotent.
  if (content.includes(cacheDateStepSentinel)) {
    let updatedCacheKey = false;
    let updatedRestoreKeys = false;

    // Update main key: insert date before run_id
    const beforeKeyUpdate = content;
    content = content.replace(
      cacheMemoryKeyLineRegex,
      (_m, prefix) => `${prefix}\${{ env.CACHE_MEMORY_DATE }}-\${{ github.run_id }}`
    );
    updatedCacheKey = content !== beforeKeyUpdate;

    // Update restore-keys prefix: append date segment
    const beforeRestoreKeysUpdate = content;
    content = content.replace(
      cacheRestoreKeyPrefixRegex,
      (_m, prefixWithWorkflowId, newline) =>
        `${prefixWithWorkflowId}\${{ env.CACHE_MEMORY_DATE }}-${newline}`
    );
    updatedRestoreKeys = content !== beforeRestoreKeysUpdate;

    if (updatedCacheKey || updatedRestoreKeys) {
      if (updatedCacheKey && updatedRestoreKeys) {
        log.push(`  Updated cache key and restore-keys to include CACHE_MEMORY_DATE for 1-day TTL`);
      } else if (updatedCacheKey) {
        log.push(`  Updated cache key to include CACHE_MEMORY_DATE for 1-day TTL`);
      } else {
        log.push(`  Updated restore-keys to include CACHE_MEMORY_DATE for 1-day TTL`);
      }
    } else {
      log.push(`  Cache key/restore-keys already include CACHE_MEMORY_DATE`);
    }
  } else if (content.includes(cacheDateRestoreKeySentinel)) {
    log.push(`  Cache key/restore-keys already include CACHE_MEMORY_DATE`);
  }

  return { content, log };
}
