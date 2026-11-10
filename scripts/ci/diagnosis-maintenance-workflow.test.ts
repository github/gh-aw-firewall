import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('shared diagnosis-maintenance contract', () => {
  const shared = read('.github/workflows/shared/diagnosis-maintenance.md');

  it('documents the common proposal primitives', () => {
    for (const fragment of [
      'docs/diagnostics/findings/<boundary>/<ID>.json',
      'docs/diagnostics/patterns.md',
      '/tmp/gh-aw/agent/scan-since.txt',
      'scripts/diagnostics/cli.ts search',
      'npm run diagnostics:validate',
      'npm run diagnostics:check',
    ]) {
      expect(shared).toContain(fragment);
    }
  });

  it('requires deduplication, safe evidence and noop behaviour', () => {
    expect(shared).toContain('finding ID plus source citation');
    expect(shared).toMatch(/never recycle or renumber an id/i);
    expect(shared).toMatch(/noop/);
    expect(shared).toMatch(/never copy credentials/i);
  });

  it('is imported by every maintenance boundary', () => {
    for (const workflow of [
      '.github/workflows/self-hosted-runner-doctor-updater.md',
      '.github/workflows/auth-doctor-updater.md',
      '.github/workflows/runtime-enclave-doctor-updater.md',
      '.github/workflows/network-doctor-updater.md',
      '.github/workflows/ci-integration-doctor-updater.md',
    ]) {
      expect(read(workflow)).toContain('- shared/diagnosis-maintenance.md');
    }
  });

  it('makes both updaters propose canonical registry changes', () => {
    expect(read('.github/workflows/self-hosted-runner-doctor-updater.md')).toContain(
      'docs/diagnostics/findings/runner/<ID>.json'
    );
    expect(read('.github/workflows/auth-doctor-updater.md')).toContain(
      'docs/diagnostics/findings/auth/'
    );
  });

  it('lets the auth updater write auth records and the generated README index only', () => {
    const auth = read('.github/workflows/auth-doctor-updater.md');
    expect(auth).toContain('- docs/diagnostics/findings/auth/*.json');
    expect(auth).toContain('- docs/diagnostics/README.md');
    expect(auth).not.toContain('- .github/workflows/shared/diagnosis-findings.md');
    expect(auth).not.toContain('- .github/agents/diagnose-awf.md');
    expect(auth).toMatch(/Do not write generated prompt or agent surfaces/i);
  });

  it('shares deterministic intake after cache restore and before updater agents run', () => {
    expect(shared).toContain('Install root dependencies for diagnostics tooling');
    expect(shared).toContain('if npm ci; then');
    expect(shared).toContain('scripts/diagnostics/intake.ts');
    expect(shared).toContain('cache-memory: true');
    expect(shared).toContain('name: diagnosis-intake');
    expect(shared).toContain('receipts.json');
    expect(shared).toContain('needs-evidence');
    expect(shared).toContain('npm run diagnostics:freshness');
    expect(shared).toContain('reviewQueue.firstTime');
    expect(shared).toContain('reviewQueue.deferred');
    expect(shared).toContain('updatedSince');
    expect(shared).toContain('date-independent keys');
    expect(read('.github/workflows/self-hosted-runner-doctor-updater.md')).not.toContain('prepare_candidates');
  });

  it('restricts each new updater to its own canonical records, not generated prompts or security', () => {
    for (const [workflow, boundary] of [
      ['runtime-enclave-doctor-updater', 'runtime'],
      ['network-doctor-updater', 'network'],
      ['ci-integration-doctor-updater', 'ci'],
    ]) {
      const source = read(`.github/workflows/${workflow}.md`);
      expect(source).toContain(`- docs/diagnostics/findings/${boundary}/*.json`);
      expect(source).toContain('max: 1');
      expect(source).not.toContain('strict: false');
      expect(source).not.toContain('enabled: false');
      for (const forbidden of ['security/*.json', '- .github/agents/', '- .github/workflows/', 'contents: write']) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('checks deadline freshness and generated parity without enabling writes', () => {
    const workflow = read('.github/workflows/diagnosis-freshness.yml');
    expect(workflow).toContain('diagnostics:validate && npm run diagnostics:check');
    expect(workflow).toContain('cli.ts freshness');
    expect(workflow).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
    expect(workflow).not.toContain(': write');
  });

  it('imports the generated findings catalog into the Runner Doctor workflow', () => {
    expect(read('.github/workflows/self-hosted-runner-doctor.md')).toContain(
      '- shared/diagnosis-findings.md'
    );
    expect(read('.github/workflows/self-hosted-runner-doctor.lock.yml')).toContain(
      '{{#runtime-import .github/workflows/shared/diagnosis-findings.md}}'
    );
  });

  it('makes CI Doctor a read-only registry consumer', () => {
    const ciDoctor = read('.github/workflows/ci-doctor.md');
    expect(ciDoctor).toContain('- shared/diagnosis-findings.md');
    expect(ciDoctor).toContain('docs/diagnostics/');
    expect(ciDoctor).toMatch(/read-only consumer/i);
    expect(ciDoctor).toMatch(/never edit registry records/i);
  });

  it('cross-links the specialist skills to the diagnose-awf entry point', () => {
    for (const skill of [
      '.github/skills/debug-firewall/SKILL.md',
      '.github/skills/awf-debug-tools/SKILL.md',
      '.github/skills/debugging-workflows/SKILL.md',
    ]) {
      expect(read(skill)).toContain('../diagnose-awf/SKILL.md');
    }
  });

  it('keeps the maintenance lock files compiled from their sources', () => {
    for (const workflow of [
      'self-hosted-runner-doctor',
      'self-hosted-runner-doctor-updater',
      'auth-doctor-updater',
      'runtime-enclave-doctor-updater',
      'network-doctor-updater',
      'ci-integration-doctor-updater',
    ]) {
      const lock = read(`.github/workflows/${workflow}.lock.yml`);
      expect(lock).toContain('DO NOT EDIT');
      expect(lock).toContain('shared/diagnosis-');
    }
  });

  it('uses durable, isolated cache state with metadata-only quarantine reports in every updater lock', () => {
    for (const workflow of [
      'self-hosted-runner-doctor-updater',
      'auth-doctor-updater',
      'runtime-enclave-doctor-updater',
      'network-doctor-updater',
      'ci-integration-doctor-updater',
    ]) {
      const lock = read(`.github/workflows/${workflow}.lock.yml`);
      expect(lock).toMatch(
        /key: memory-(?:none|approved)-(?:nopolicy|[a-f0-9]{8})-\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}-\$\{\{ github\.run_id \}\}/
      );
      expect(lock).toMatch(
        /memory-(?:none|approved)-(?:nopolicy|[a-f0-9]{8})-\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}-\n/
      );
      expect(lock).not.toContain('CACHE_MEMORY_DATE');
      expect(lock).not.toContain('--add-dir /tmp/gh-aw/cache-memory/');
      expect(lock).toContain('Strip execute bits from cache-memory files');
      expect(lock).toContain('Scan cache-memory for instruction-injection content');
      expect(lock).toContain('Content preview suppressed for security: $f');
      expect(lock).not.toContain('head -5 "$f"');
    }
  });
});
