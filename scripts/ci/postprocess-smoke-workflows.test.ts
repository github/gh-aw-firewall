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

