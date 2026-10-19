import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../..');
const script = path.join(__dirname, 'run-cloud-hypervisor-build-smoke.sh');
const workflowPath = path.join(repoRoot, '.github/workflows/smoke-cloud-hypervisor-build-test.md');

const stub = `#!/bin/bash
tool=$(basename "$0")
printf '%s:%s:%s\\n' "$tool" "$PWD" "$*" >> "$STUB_CALLS"
case "$tool" in
  curl)
    last=
    for argument in "$@"; do last=$argument; done
    case "$last" in
      https://github.com) printf '%s' "\${STUB_GITHUB_CODE:-200}"; exit 0 ;;
      https://example.com) printf '%s' "\${STUB_BLOCKED_CODE:-000}"; exit 7 ;;
    esac
    exit 90 ;;
  timeout) shift; exec "$@" ;;
  npm)
    case "$*" in
      --version) echo stub; exit 0 ;;
      ci) exit "\${STUB_NPM_CI_EXIT:-0}" ;;
      "run build") exit "\${STUB_NPM_BUILD_EXIT:-0}" ;;
    esac
    exit 90 ;;
  npx)
    output=
    for argument in "$@"; do
      case "$argument" in --outputFile=*) output=\${argument#--outputFile=} ;; esac
    done
    [ -n "$output" ] || exit 90
    printf '%s\\n' '{"testResults":[{"name":"linux-only.test.ts","message":"complete assertion details"}]}' > "$output"
    echo "original failing assertion"
    for ((i=0; i<30; i++)); do echo "later output"; done
    exit "\${STUB_JEST_EXIT:-0}" ;;
  git)
    if [ "$1" = init ]; then mkdir -p "$3/color" "$3/uuid"; exit 0; fi
    case "$3" in
      remote) exit 0 ;;
      fetch) exit "\${STUB_FETCH_EXIT:-0}" ;;
      checkout) exit "\${STUB_CHECKOUT_EXIT:-0}" ;;
    esac
    exit 90 ;;
  go)
    case "$*" in
      version) echo stub; exit 0 ;;
      "mod download") exit "\${STUB_GO_DOWNLOAD_EXIT:-0}" ;;
      "build ./...") exit "\${STUB_GO_BUILD_EXIT:-0}" ;;
      "test ./...") exit "\${STUB_GO_TEST_EXIT:-0}" ;;
    esac
    exit 90 ;;
esac
exit 90
`;

describe('Cloud Hypervisor build smoke runner', () => {
  let temporary: string;
  let bin: string;
  let results: string;
  let calls: string;

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-build-smoke-test-'));
    bin = path.join(temporary, 'bin');
    results = path.join(temporary, 'results');
    calls = path.join(temporary, 'calls.log');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    for (const command of ['curl', 'timeout', 'npm', 'npx', 'git', 'go']) {
      fs.writeFileSync(path.join(bin, command), stub, { mode: 0o755 });
    }
  });

  afterEach(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  function run(overrides: Record<string, string> = {}) {
    const processResult = spawnSync('/bin/bash', [script, results], {
      cwd: temporary,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: temporary,
        STUB_CALLS: calls,
        ...overrides,
      },
    });
    if (processResult.error) throw processResult.error;
    return {
      processResult,
      recorded: JSON.parse(fs.readFileSync(path.join(results, 'build-test-results.json'), 'utf8')),
      calls: fs.readFileSync(calls, 'utf8'),
    };
  }

  it('runs the whole checked-in workload and records the exact result contract', () => {
    const output = run();
    expect(output.processResult.status).toBe(0);
    expect(output.recorded).toEqual({
      http_code: '200',
      node_build: 'PASS',
      node_test: 'PASS',
      go_build: 'PASS',
      go_test: 'PASS',
      network_isolation: 'PASS',
    });
    expect(output.calls).toContain(`npm:${repoRoot}:ci`);
    expect(output.calls).toContain('--testPathPatterns=squid-config|docker-manager|logger');
    expect(output.calls).toContain('fetch --depth 1 origin c3e84fc697814119dba3b0ad82566dc2b2bbb880');
    expect(output.calls).toMatch(/go:.*\/color:test \.\/\.\.\./);
    expect(output.calls).toMatch(/go:.*\/uuid:test \.\/\.\.\./);
  });

  it.each([
    ['STUB_NPM_CI_EXIT', 'node_build'],
    ['STUB_NPM_BUILD_EXIT', 'node_build'],
    ['STUB_JEST_EXIT', 'node_test'],
    ['STUB_GO_DOWNLOAD_EXIT', 'go_build'],
    ['STUB_GO_BUILD_EXIT', 'go_build'],
    ['STUB_GO_TEST_EXIT', 'go_test'],
  ])('records %s failures without suppressing subsequent checks', (variable, field) => {
    const output = run({ [variable]: '1' });
    expect(output.processResult.status).toBe(1);
    expect(output.recorded[field]).toBe('FAIL');
    expect(output.recorded.network_isolation).toBe('PASS');
    expect(output.calls).toContain('https://example.com');
    expect(output.processResult.stderr).toContain('workload failed');
  });

  it.each(['STUB_FETCH_EXIT', 'STUB_CHECKOUT_EXIT'])('records %s without a false Go pass', (variable) => {
    const output = run({ [variable]: '1' });
    expect(output.processResult.status).toBe(1);
    expect(output.recorded.go_build).toBe('CLONE_FAILED');
    expect(output.recorded.go_test).toBe('SKIPPED');
    expect(output.recorded.network_isolation).toBe('PASS');
  });

  it('retains complete Jest output and machine-readable failure details', () => {
    const output = run({ STUB_JEST_EXIT: '1' });
    expect(output.processResult.status).toBe(1);
    expect(output.processResult.stdout).not.toContain('original failing assertion');
    expect(fs.readFileSync(path.join(results, 'build-test-jest.log'), 'utf8'))
      .toContain('original failing assertion');
    expect(JSON.parse(fs.readFileSync(path.join(results, 'build-test-jest-results.json'), 'utf8')))
      .toEqual({ testResults: [{ name: 'linux-only.test.ts', message: 'complete assertion details' }] });
  });

  it('writes failure results on an early fixture-staging exit', () => {
    fs.writeFileSync(path.join(bin, 'mktemp'), '#!/bin/bash\necho "fixture staging failed" >&2\nexit 1\n', { mode: 0o755 });
    const output = run();
    expect(output.processResult.status).toBe(1);
    expect(output.recorded.node_build).toBe('PASS');
    expect(output.recorded.go_build).toBe('FAIL');
    expect(output.recorded.network_isolation).toBe('FAIL');
    expect(output.processResult.stderr).toContain('fixture staging failed');
  });

  it('does not retain stale Jest results when Jest cannot start', () => {
    fs.mkdirSync(results);
    const jestResults = path.join(results, 'build-test-jest-results.json');
    fs.writeFileSync(jestResults, '{"success":true}');
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/bash\necho "Jest startup failed" >&2\nexit 2\n', { mode: 0o755 });
    const output = run();
    expect(output.processResult.status).toBe(1);
    expect(output.recorded.node_test).toBe('FAIL');
    expect(fs.existsSync(jestResults)).toBe(false);
    expect(fs.readFileSync(path.join(results, 'build-test-jest.log'), 'utf8'))
      .toContain('Jest startup failed');
  });

  it('fails when the negative network probe succeeds', () => {
    const output = run({ STUB_BLOCKED_CODE: '200' });
    expect(output.processResult.status).toBe(1);
    expect(output.recorded.network_isolation).toBe('FAIL');
  });

  it('accepts an explicit Squid denial and fails unexpected positive-probe status', () => {
    expect(run({ STUB_BLOCKED_CODE: '403' }).processResult.status).toBe(0);
    const failed = run({ STUB_GITHUB_CODE: '503' });
    expect(failed.processResult.status).toBe(1);
    expect(failed.recorded.http_code).toBe('503');
  });

  it('uses one script command and preserves diagnostics even if the validator fails', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('bash scripts/ci/run-cloud-hypervisor-build-smoke.sh');
    expect(workflow).toContain('Do not reproduce, shorten, split, or rewrite');
    expect(workflow).toContain('Never synthesize or edit the results file.');
    expect(workflow).not.toContain('npx jest --ci');
    const match = workflow.match(/^---\n([\s\S]*?)\n---/);
    if (!match) throw new Error('Missing workflow frontmatter');
    const frontmatter = yaml.load(match[1]) as {
      'post-steps': Array<{ name: string; if?: string; uses?: string; with?: Record<string, unknown> }>;
    };
    const steps = frontmatter['post-steps'];
    const validation = steps.findIndex(step => step.name === 'Validate build test results');
    const upload = steps.findIndex(step => step.name === 'Upload build test diagnostics');
    expect(upload).toBeGreaterThan(validation);
    expect(steps[upload].if).toBe('always()');
    expect(steps[upload].uses).toBe('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
    expect(steps[upload].with?.name).toBe('cloud-hypervisor-build-test-diagnostics');
    expect(steps[upload].with?.path).toContain('/tmp/gh-aw/agent/build-test-jest-results.json');
    expect(steps[upload].with?.['retention-days'])
      .toBe("${{ vars.GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS || '7' }}");
    const lock = fs.readFileSync(path.join(repoRoot, '.github/workflows/smoke-cloud-hypervisor-build-test.lock.yml'), 'utf8');
    expect(lock).toContain('name: cloud-hypervisor-build-test-diagnostics');
    expect(lock).toContain(
      "retention-days: ${{ vars.GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS || (vars.GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS || '7') }}",
    );
  });
});
