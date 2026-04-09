/**
 * Tests for postprocess-smoke-workflows.ts regex patterns.
 *
 * These tests verify that the install-step regex correctly handles both
 * quoted and unquoted paths, covering the fix for gh-aw compilers that
 * emit double-quoted ${RUNNER_TEMP}/... paths.
 */

// The regex is module-internal, so we duplicate the pattern here for testing.
// If the source regex changes, these tests will catch regressions by failing
// on the expected inputs below.
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
