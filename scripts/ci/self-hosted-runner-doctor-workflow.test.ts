import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'self-hosted-runner-doctor.md');
const sharedPath = path.join(workflowsDir, 'shared/self-hosted-failure-modes.md');
const lockPath = path.join(workflowsDir, 'self-hosted-runner-doctor.lock.yml');

describe('self-hosted runner doctor workflow config', () => {
  it('defines a community-facing slash command workflow with the shared failure-mode import', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const shared = fs.readFileSync(sharedPath, 'utf-8');

    expect(source).toContain('name: Self-Hosted Runner Doctor');
    expect(source).toContain('roles: all');
    expect(source).toContain('slash_command:');
    expect(source).toContain('name: runner-doctor');
    expect(source).toContain('shared/self-hosted-failure-modes.md');
    expect(source).toContain('title-prefix: "🩺 Runner Doctor"');
    expect(shared).toContain('## Category A — ARC / DinD');
    expect(shared).toContain('| A10 | `Docker socket not found` plus `Invalid container ID format: arc-...` |');
  });

  it('compiles the trigger, safe outputs, and knowledge-base references into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('runner-doctor');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('🩺 Runner Doctor');
    expect(lock).toContain('shared/self-hosted-failure-modes.md');
    expect(lock).toContain('github/gh-aw-actions/setup@3c7f3b6f423dd721e2f115b7c8fda65287e1f137');
  });
});
