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

  it('lets the auth updater write auth records and the regenerated index', () => {
    const auth = read('.github/workflows/auth-doctor-updater.md');
    expect(auth).toContain('- docs/diagnostics/findings/auth/*.json');
    expect(auth).toContain('- docs/diagnostics/README.md');
  });

  it('imports the generated findings catalog into the Runner Doctor workflow', () => {
    expect(read('.github/workflows/self-hosted-runner-doctor.md')).toContain(
      '- shared/diagnosis-findings.md'
    );
    expect(read('.github/workflows/self-hosted-runner-doctor.lock.yml')).toContain(
      '{{#runtime-import .github/workflows/shared/diagnosis-findings.md}}'
    );
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
