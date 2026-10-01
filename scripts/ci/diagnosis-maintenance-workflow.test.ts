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

  it('is imported by the runner and auth maintenance workflows', () => {
    for (const workflow of [
      '.github/workflows/self-hosted-runner-doctor-updater.md',
      '.github/workflows/auth-doctor-updater.md',
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

  it('installs diagnostics tooling before updater agents run', () => {
    const runner = read('.github/workflows/self-hosted-runner-doctor-updater.md');
    expect(runner).toContain('Install root dependencies for diagnostics tooling');
    expect(runner).toContain('for attempt in 1 2 3; do');
    expect(runner).toContain('if npm ci; then');
    expect(runner).toContain('if [ "$attempt" -eq 3 ]; then');
    expect(runner).toContain('sleep $((attempt * 5))');

    const auth = read('.github/workflows/auth-doctor-updater.md');
    expect(auth).toContain('Install root dependencies for diagnostics tooling');
    expect(auth).toContain('run: npm ci');
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
    ]) {
      const lock = read(`.github/workflows/${workflow}.lock.yml`);
      expect(lock).toContain('DO NOT EDIT');
      expect(lock).toContain('shared/diagnosis-');
    }
  });
});
