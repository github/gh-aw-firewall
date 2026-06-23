import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'self-hosted-runner-doctor-updater.md');
const lockPath = path.join(workflowsDir, 'self-hosted-runner-doctor-updater.lock.yml');

describe('runner doctor updater workflow config', () => {
  it('defines a daily knowledge-base maintenance workflow with the shared failure-mode import', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('name: Runner Doctor Updater');
    expect(source).toContain('schedule: daily');
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('shared/self-hosted-failure-modes.md');
    expect(source).toContain('title-prefix: "🩺 Runner Doctor Update"');
    expect(source).toContain('label:runner-doctor');
    expect(source).toContain('Compute scan window');
  });

  it('compiles the schedule, scan window, safe outputs, and knowledge-base references into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('schedule:');
    expect(lock).toContain('cron:');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('🩺 Runner Doctor Update');
    expect(lock).toContain('shared/self-hosted-failure-modes.md');
    expect(lock).toContain('Compute scan window');
    expect(lock).toContain('github/gh-aw-actions/setup@3c7f3b6f423dd721e2f115b7c8fda65287e1f137');
  });
});
