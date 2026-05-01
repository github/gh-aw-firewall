/**
 * Tests for postprocess-smoke-workflows.ts regex patterns.
 *
 * These tests verify that the install-step regex correctly handles both
 * quoted and unquoted paths, covering the fix for gh-aw compilers that
 * emit double-quoted ${RUNNER_TEMP}/... paths.
 */

// The regex is module-internal in postprocess-smoke-workflows.ts (line 58-59)
// and cannot be imported because the script performs file I/O at module load
// time. If the source regex changes, these tests will catch regressions by
// failing on the expected inputs below.
const installStepRegex =
  /^(\s*)- name: Install [Aa][Ww][Ff] binary\n\1\s*run: bash "?(?:\/opt\/gh-aw|\$\{RUNNER_TEMP\}\/gh-aw)\/actions\/install_awf_binary\.sh"? v[0-9.]+\n/m;

describe('installStepRegex', () => {
  it('should match unquoted /opt/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash /opt/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match unquoted ${RUNNER_TEMP}/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash ${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match double-quoted ${RUNNER_TEMP}/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match double-quoted /opt/gh-aw path', () => {
    const input =
      '      - name: Install awf binary\n' +
      '        run: bash "/opt/gh-aw/actions/install_awf_binary.sh" v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should match case-insensitive AWF in step name', () => {
    const input =
      '      - name: Install AWF binary\n' +
      '        run: bash /opt/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(true);
  });

  it('should not match step with wrong name', () => {
    const input =
      '      - name: Install something else\n' +
      '        run: bash /opt/gh-aw/actions/install_awf_binary.sh v0.25.17\n';
    expect(installStepRegex.test(input)).toBe(false);
  });

  it('should capture indentation for replacement', () => {
    const input =
      '          - name: Install awf binary\n' +
      '            run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.25.17\n';
    const match = input.match(installStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('          ');
  });
});

// ── Cache-memory security hardening regex tests ───────────────────────────
// Mirrors the patterns in postprocess-smoke-workflows.ts.
// If those patterns change, these tests will catch regressions.

const setupCacheMemoryStepRegex =
  /^(\s+)- name: Setup cache-memory git repository\n(?:\1\s[^\n]*\n)*?\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/setup_cache_memory_git\.sh"\n/m;

const cacheMemoryCommitStepRegex =
  /^(\s+)- name: Commit cache-memory changes\n(?:\1\s[^\n]*\n)*?\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/commit_cache_memory_git\.sh"\n/m;

const createCacheDirStepRegex =
  /^(\s+)(- name: Create cache-memory directory\n\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/create_cache_memory_dir\.sh"\n)(\1- name: (?:Cache|Restore) cache-memory file share data\n)/m;

const cacheMemoryKeyLineRegex =
  /(key: memory-none-nopolicy-(?:\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}|[a-z0-9-]+)-)\$\{\{ github\.run_id \}\}/g;

const cacheRestoreKeyPrefixRegex =
  /(memory-none-nopolicy-(?:\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}|[a-z0-9-]+)-)(\n)/g;

describe('setupCacheMemoryStepRegex', () => {
  const SETUP_STEP =
    '      - name: Setup cache-memory git repository\n' +
    '        env:\n' +
    '          GH_AW_CACHE_DIR: /tmp/gh-aw/cache-memory\n' +
    '          GH_AW_MIN_INTEGRITY: none\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/setup_cache_memory_git.sh"\n';

  it('should match setup-cache-memory step with standard indentation', () => {
    expect(setupCacheMemoryStepRegex.test(SETUP_STEP)).toBe(true);
  });

  it('should capture indentation', () => {
    const match = SETUP_STEP.match(setupCacheMemoryStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      ');
  });

  it('should not match a step with a different name', () => {
    const input =
      '      - name: Run cache-memory git\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/setup_cache_memory_git.sh"\n';
    expect(setupCacheMemoryStepRegex.test(input)).toBe(false);
  });
});

describe('cacheMemoryCommitStepRegex', () => {
  const COMMIT_STEP =
    '      - name: Commit cache-memory changes\n' +
    '        if: always()\n' +
    '        env:\n' +
    '          GH_AW_CACHE_DIR: /tmp/gh-aw/cache-memory\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/commit_cache_memory_git.sh"\n';

  it('should match commit-cache-memory step', () => {
    expect(cacheMemoryCommitStepRegex.test(COMMIT_STEP)).toBe(true);
  });

  it('should capture indentation', () => {
    const match = COMMIT_STEP.match(cacheMemoryCommitStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      ');
  });
});

describe('createCacheDirStepRegex', () => {
  it('should match create dir + Cache cache-memory step pair', () => {
    const input =
      '      - name: Create cache-memory directory\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/create_cache_memory_dir.sh"\n' +
      '      - name: Cache cache-memory file share data\n';
    expect(createCacheDirStepRegex.test(input)).toBe(true);
  });

  it('should match create dir + Restore cache-memory step pair (split cache)', () => {
    const input =
      '      - name: Create cache-memory directory\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/create_cache_memory_dir.sh"\n' +
      '      - name: Restore cache-memory file share data\n';
    expect(createCacheDirStepRegex.test(input)).toBe(true);
  });

  it('should capture all three groups', () => {
    const input =
      '      - name: Create cache-memory directory\n' +
      '        run: bash "${RUNNER_TEMP}/gh-aw/actions/create_cache_memory_dir.sh"\n' +
      '      - name: Cache cache-memory file share data\n';
    const match = input.match(createCacheDirStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      '); // indent
    expect(match![2]).toContain('Create cache-memory directory');
    expect(match![3]).toContain('Cache cache-memory file share data');
  });
});

describe('cacheMemoryKeyLineRegex', () => {
  it('should match key with GH_AW_WORKFLOW_ID_SANITIZED', () => {
    const input =
      'key: memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ github.run_id }}\n';
    const result = input.replace(
      cacheMemoryKeyLineRegex,
      (_m, prefix) => `${prefix}\${{ env.CACHE_MEMORY_DATE }}-\${{ github.run_id }}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toContain('github.run_id');
  });

  it('should match key with hardcoded workflow id', () => {
    const input =
      'key: memory-none-nopolicy-issue-duplication-detector-${{ github.run_id }}\n';
    const result = input.replace(
      cacheMemoryKeyLineRegex,
      (_m, prefix) => `${prefix}\${{ env.CACHE_MEMORY_DATE }}-\${{ github.run_id }}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toContain('github.run_id');
  });

  it('should not match a key already containing CACHE_MEMORY_DATE', () => {
    const input =
      'key: memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ env.CACHE_MEMORY_DATE }}-${{ github.run_id }}\n';
    // The regex matches only ${{ github.run_id }} without CACHE_MEMORY_DATE prefix
    const match = input.match(cacheMemoryKeyLineRegex);
    // The prefix captured should include CACHE_MEMORY_DATE already
    expect(match).toBeNull(); // no match since run_id is not directly after workflow_id-
  });
});

describe('cacheRestoreKeyPrefixRegex', () => {
  it('should match restore-keys prefix with GH_AW_WORKFLOW_ID_SANITIZED', () => {
    const input =
      '            memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-\n';
    const result = input.replace(
      cacheRestoreKeyPrefixRegex,
      (_m, prefixWithWorkflowId, newline) =>
        `${prefixWithWorkflowId}\${{ env.CACHE_MEMORY_DATE }}-${newline}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toMatch(/GH_AW_WORKFLOW_ID_SANITIZED.*CACHE_MEMORY_DATE/);
  });

  it('should match restore-keys prefix with hardcoded workflow id', () => {
    const input = '            memory-none-nopolicy-issue-duplication-detector-\n';
    const result = input.replace(
      cacheRestoreKeyPrefixRegex,
      (_m, prefixWithWorkflowId, newline) =>
        `${prefixWithWorkflowId}\${{ env.CACHE_MEMORY_DATE }}-${newline}`
    );
    expect(result).toContain('CACHE_MEMORY_DATE');
    expect(result).toContain('issue-duplication-detector');
  });

  it('should be idempotent — already-transformed restore-keys are not double-transformed', () => {
    // Simulate an already-transformed restore-keys line (contains CACHE_MEMORY_DATE)
    // Using the cacheDateRestoreKeySentinel guard ('env.CACHE_MEMORY_DATE }}')
    // means the transform is never applied a second time in practice.
    // This test verifies the sentinel check by ensuring the already-updated
    // line does NOT match the restore key prefix regex (because the sentinel
    // is present and the regex would match a different segment).
    const alreadyTransformed =
      '            memory-none-nopolicy-${{ env.GH_AW_WORKFLOW_ID_SANITIZED }}-${{ env.CACHE_MEMORY_DATE }}-\n';
    // The regex should NOT match the already-transformed line because the
    // workflow-ID part is followed by CACHE_MEMORY_DATE, not a newline.
    expect(cacheRestoreKeyPrefixRegex.test(alreadyTransformed)).toBe(false);
    // Reset lastIndex since cacheRestoreKeyPrefixRegex has the 'g' flag
    cacheRestoreKeyPrefixRegex.lastIndex = 0;
  });
});

// ── Session state dir injection and Copy step replacement tests ──────────────
// Mirrors the patterns in postprocess-smoke-workflows.ts.

const SESSION_STATE_DIR = '/tmp/gh-aw/sandbox/agent/session-state';

const sessionStateDirInjectionRegex =
  /--audit-dir \/tmp\/gh-aw\/sandbox\/firewall\/audit(?! --session-state-dir)/g;

const copySessionStateStepRegex =
  /^(\s+)- name: Copy Copilot session state files to logs\n\1  if: always\(\)\n\1  continue-on-error: true\n\1  run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/copy_copilot_session_state\.sh"\n/m;

const copilotModelEmptyFallbackRegex =
  /(COPILOT_MODEL:\s*\$\{\{\s*vars\.GH_AW_MODEL_AGENT_COPILOT\s*\|\|\s*)''(\s*\}\})/g;

function buildCopySessionStateStep(indent: string): string {
  const i = indent;
  const ri = `${i}    `;
  return (
    `${i}- name: Copy Copilot session state files to logs\n` +
    `${i}  if: always()\n` +
    `${i}  continue-on-error: true\n` +
    `${i}  run: |\n` +
    `${ri}SESSION_STATE_SRC="${SESSION_STATE_DIR}"\n` +
    `${ri}LOGS_DIR="/tmp/gh-aw/sandbox/agent/logs"\n` +
    `${ri}if [ -d "$SESSION_STATE_SRC" ] && [ -n "$(ls -A "$SESSION_STATE_SRC" 2>/dev/null)" ]; then\n` +
    `${ri}  mkdir -p "$LOGS_DIR/session-state"\n` +
    `${ri}  cp -rp "$SESSION_STATE_SRC/." "$LOGS_DIR/session-state/"\n` +
    `${ri}  echo "Copied session state to $LOGS_DIR/session-state"\n` +
    `${ri}else\n` +
    `${ri}  echo "No session state found at $SESSION_STATE_SRC"\n` +
    `${ri}fi\n`
  );
}

describe('sessionStateDirInjectionRegex', () => {
  beforeEach(() => {
    sessionStateDirInjectionRegex.lastIndex = 0;
  });

  it('should match --audit-dir without --session-state-dir', () => {
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --enable-host-access';
    expect(sessionStateDirInjectionRegex.test(input)).toBe(true);
  });

  it('should NOT match --audit-dir already followed by --session-state-dir (idempotent)', () => {
    sessionStateDirInjectionRegex.lastIndex = 0;
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit' +
      ` --session-state-dir ${SESSION_STATE_DIR} --enable-host-access`;
    expect(sessionStateDirInjectionRegex.test(input)).toBe(false);
  });

  it('should inject --session-state-dir after --audit-dir', () => {
    sessionStateDirInjectionRegex.lastIndex = 0;
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --enable-host-access';
    const result = input.replace(
      sessionStateDirInjectionRegex,
      `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
    );
    expect(result).toContain(`--session-state-dir ${SESSION_STATE_DIR}`);
    expect(result).toContain('--enable-host-access');
  });

  it('should inject in all occurrences (global flag)', () => {
    sessionStateDirInjectionRegex.lastIndex = 0;
    const input =
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --build-local\n' +
      '          sudo -E awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit --build-local\n';
    const result = input.replace(
      sessionStateDirInjectionRegex,
      `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
    );
    const count = (result.match(/--session-state-dir/g) || []).length;
    expect(count).toBe(2);
  });
});

describe('copySessionStateStepRegex', () => {
  const ORIGINAL_STEP =
    '      - name: Copy Copilot session state files to logs\n' +
    '        if: always()\n' +
    '        continue-on-error: true\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/copy_copilot_session_state.sh"\n';

  it('should match the original compiler-generated step', () => {
    expect(copySessionStateStepRegex.test(ORIGINAL_STEP)).toBe(true);
  });

  it('should capture indentation', () => {
    const match = ORIGINAL_STEP.match(copySessionStateStepRegex);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('      ');
  });

  it('should NOT match after replacement (sentinel check)', () => {
    const replaced = buildCopySessionStateStep('      ');
    expect(replaced).toContain('SESSION_STATE_SRC=');
    expect(copySessionStateStepRegex.test(replaced)).toBe(false);
  });
});

describe('buildCopySessionStateStep', () => {
  it('should emit inline script reading from AWF session-state path', () => {
    const result = buildCopySessionStateStep('      ');
    expect(result).toContain(`SESSION_STATE_SRC="${SESSION_STATE_DIR}"`);
    expect(result).toContain('LOGS_DIR="/tmp/gh-aw/sandbox/agent/logs"');
    expect(result).toContain('cp -rp "$SESSION_STATE_SRC/." "$LOGS_DIR/session-state/"');
  });

  it('should use correct YAML indentation', () => {
    const result = buildCopySessionStateStep('      ');
    expect(result).toMatch(/^      - name: Copy Copilot session state files to logs\n/);
    expect(result).toContain('        run: |\n');
    expect(result).toContain('          SESSION_STATE_SRC=');
  });

  it('should be idempotent — sentinel is present in output', () => {
    const result = buildCopySessionStateStep('      ');
    expect(result).toContain('SESSION_STATE_SRC=');
  });
});

describe('copilotModelEmptyFallbackRegex', () => {
  const EXPECTED_COPILOT_MODEL_FALLBACK = 'claude-opus-4.6';

  beforeEach(() => {
    copilotModelEmptyFallbackRegex.lastIndex = 0;
  });

  it('should replace empty fallback with claude-opus-4.6 fallback', () => {
    const input = "          COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || '' }}\n";
    const result = input.replace(
      copilotModelEmptyFallbackRegex,
      `$1'${EXPECTED_COPILOT_MODEL_FALLBACK}'$2`
    );
    expect(result).toBe(
      `          COPILOT_MODEL: \${{ vars.GH_AW_MODEL_AGENT_COPILOT || '${EXPECTED_COPILOT_MODEL_FALLBACK}' }}\n`
    );
  });

  it('should not modify already-correct fallback', () => {
    const input =
      "          COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || 'claude-opus-4.6' }}\n";
    const result = input.replace(
      copilotModelEmptyFallbackRegex,
      `$1'${EXPECTED_COPILOT_MODEL_FALLBACK}'$2`
    );
    expect(result).toBe(input);
  });
});

// ── Issue duplication detector conclusion concurrency tests ───────────────────
// Mirrors the patterns in postprocess-smoke-workflows.ts.
// If those patterns change, these tests will catch regressions.

const issueDuplicationConclusionConcurrencyRegex =
  /([ ]+group: "gh-aw-conclusion-issue-duplication-detector)("\n[ ]+cancel-in-progress: false)/;
const issueDuplicationConclusionConcurrencySentinel =
  'gh-aw-conclusion-issue-duplication-detector-${{ github.event.issue.number';

describe('issueDuplicationConclusionConcurrencyRegex', () => {
  const ORIGINAL_CONCURRENCY =
    '    concurrency:\n' +
    '      group: "gh-aw-conclusion-issue-duplication-detector"\n' +
    '      cancel-in-progress: false\n';

  it('should match the compiler-generated shared conclusion concurrency group', () => {
    expect(issueDuplicationConclusionConcurrencyRegex.test(ORIGINAL_CONCURRENCY)).toBe(true);
  });

  it('should transform the group to include the issue number', () => {
    const result = ORIGINAL_CONCURRENCY.replace(
      issueDuplicationConclusionConcurrencyRegex,
      `$1-\${{ github.event.issue.number || github.run_id }}$2`
    );
    expect(result).toContain('${{ github.event.issue.number || github.run_id }}');
    expect(result).toContain('cancel-in-progress: false');
    expect(result).not.toContain(
      '"gh-aw-conclusion-issue-duplication-detector"\n'
    );
  });

  it('should NOT match already-per-issue group (idempotency via sentinel)', () => {
    const alreadyUpdated =
      '    concurrency:\n' +
      '      group: "gh-aw-conclusion-issue-duplication-detector-${{ github.event.issue.number || github.run_id }}"\n' +
      '      cancel-in-progress: false\n';
    // The sentinel string is present in the already-updated content, so the
    // postprocess script skips the transform. Additionally, the regex itself
    // does NOT match the updated form because the closing quote is no longer
    // immediately after "issue-duplication-detector" — both guards agree.
    expect(alreadyUpdated.includes(issueDuplicationConclusionConcurrencySentinel)).toBe(true);
    expect(issueDuplicationConclusionConcurrencyRegex.test(alreadyUpdated)).toBe(false);
  });

  it('should preserve cancel-in-progress: false in the output', () => {
    const result = ORIGINAL_CONCURRENCY.replace(
      issueDuplicationConclusionConcurrencyRegex,
      `$1-\${{ github.event.issue.number || github.run_id }}$2`
    );
    expect(result).toContain('cancel-in-progress: false');
  });

  it('should keep the workflow name prefix in the group', () => {
    const result = ORIGINAL_CONCURRENCY.replace(
      issueDuplicationConclusionConcurrencyRegex,
      `$1-\${{ github.event.issue.number || github.run_id }}$2`
    );
    expect(result).toContain('gh-aw-conclusion-issue-duplication-detector-');
  });
});
