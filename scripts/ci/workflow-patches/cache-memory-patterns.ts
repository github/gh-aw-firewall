// Remove the "Setup Scripts" step from update_cache_memory jobs.
// This step downloads the private github/gh-aw action but is never used in
// update_cache_memory (no subsequent steps reference /opt/gh-aw/actions/).
// With permissions: {} on these jobs, downloading the private action fails
// with 401 Unauthorized.
export const updateCacheSetupScriptRegex =
  /^(\s+)- name: Setup Scripts\n\1  uses: github\/gh-aw\/actions\/setup@v[\d.]+\n\1  with:\n\1    destination: \/opt\/gh-aw\/actions\n(\1- name: Download cache-memory artifact)/gm;
// Cache-memory security hardening patterns (issue: execute-bit persistence and
// instruction-injection across cache restore cycles).
//
// 1. setupCacheMemoryStepRegex: matches the "Setup cache-memory git repository"
//    step so we can inject a sanitize step immediately after it.
// 2. stripExecBitsStepSentinel: idempotency guard — skip injection if this
//    step name already appears right after the setup step.
// 3. cacheMemoryCommitStepRegex: matches the "Commit cache-memory changes" step
//    so we can inject a scan step immediately before it.
// 4. scanInjectionStepSentinel: idempotency guard for the scan step.
// 5. cacheMemoryDateStepRegex: matches the "Create cache-memory directory" step
//    followed by the "Cache cache-memory file share data" cache action so we
//    can inject a date computation step and add a TTL to the restore-keys.
export const setupCacheMemoryStepRegex =
  /^(\s+)- name: Setup cache-memory git repository\n(?:\1\s[^\n]*\n)*?\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/setup_cache_memory_git\.sh"\n/m;
export const stripExecBitsStepSentinel = '- name: Strip execute bits from cache-memory files';
export const cacheMemoryCommitStepRegex =
  /^(\s+)- name: Commit cache-memory changes\n(?:\1\s[^\n]*\n)*?\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/commit_cache_memory_git\.sh"\n/m;
export const scanInjectionStepSentinel = '- name: Scan cache-memory for instruction-injection content';
// Matches the "Create cache-memory directory" run step (just before the cache
// action) so we can inject the date-key computation step between them.
// Handles two step names:
//   "Cache cache-memory file share data" — combined actions/cache
//   "Restore cache-memory file share data" — split actions/cache/restore + save
export const createCacheDirStepRegex =
  /^(\s+)(- name: Create cache-memory directory\n\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/create_cache_memory_dir\.sh"\n)(\1- name: (?:Cache|Restore) cache-memory file share data\n)/m;
export const cacheDateStepSentinel = '- name: Compute cache-memory TTL date key';
// Matches cache-memory key lines so we can insert the date env var for TTL.
// Handles both forms:
//   key: memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ github.run_id }}
//   key: memory-none-nopolicy-issue-duplication-detector-${{ github.run_id }}
export const cacheMemoryKeyLineRegex =
  /(key: memory-none-nopolicy-(?:\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}|[a-z0-9-]+)-)\$\{\{ github\.run_id \}\}/g;
// Matches the restore-keys prefix line for cache-memory so we can insert the
// date env var between the workflow-ID segment and the trailing dash.
export const cacheRestoreKeyPrefixRegex =
  /(memory-none-nopolicy-(?:\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}|[a-z0-9-]+)-)(\n)/g;
export const cacheDateRestoreKeySentinel = 'env.CACHE_MEMORY_DATE }}';
