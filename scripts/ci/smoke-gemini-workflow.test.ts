import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeGeminiSourcePath = path.join(workflowsDir, 'smoke-gemini.md');
const smokeGeminiLockPath = path.join(workflowsDir, 'smoke-gemini.lock.yml');

describe('smoke gemini workflow output requirements', () => {
  it('requires noop fallback when no pull request context exists', () => {
    const source = fs.readFileSync(smokeGeminiSourcePath, 'utf-8');

    expect(source).toContain('**If triggered by a pull request**');
    expect(source).toContain('**If triggered by workflow_dispatch or schedule**');
    expect(source).toContain('Do NOT attempt to add');
    expect(source).toContain('when there is no pull request');
  });

  it('uses GEMINI_API_KEY secret', () => {
    const source = fs.readFileSync(smokeGeminiSourcePath, 'utf-8');

    expect(source).toContain('GEMINI_API_KEY');
  });

  it('compiles to a lock file with ready-for-aw activation guard', () => {
    const lock = fs.readFileSync(smokeGeminiLockPath, 'utf-8');

    expect(lock).toContain("github.event.label.name == 'ready-for-aw'");
  });

  it('lock file excludes GEMINI_API_KEY from agent environment', () => {
    const lock = fs.readFileSync(smokeGeminiLockPath, 'utf-8');

    // The real key must be excluded from --env-all so the api-proxy sidecar can
    // inject it instead, providing credential isolation.
    expect(lock).toContain('--exclude-env GEMINI_API_KEY');
  });

  it('lock file installs AWF binary', () => {
    const lock = fs.readFileSync(smokeGeminiLockPath, 'utf-8');

    expect(lock).toContain('--build-local');
    expect(lock).toContain('Install awf binary (local)');
  });
});
