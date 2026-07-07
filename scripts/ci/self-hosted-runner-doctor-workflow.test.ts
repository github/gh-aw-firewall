import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'self-hosted-runner-doctor.md');
const sharedPath = path.join(workflowsDir, 'shared/self-hosted-failure-modes.md');
const lockPath = path.join(workflowsDir, 'self-hosted-runner-doctor.lock.yml');
const portableAgentPath = path.resolve(__dirname, '../../.github/agents/self-hosted-runner-doctor.md');

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
    expect(lock).toContain('github/gh-aw-actions/setup@3fac1cfa7a5a375a6a5eb9839178f6dad7adb60a');
  });

  it('keeps the shared catalog, workflow playbook, and portable agent aligned for new failure modes', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const shared = fs.readFileSync(sharedPath, 'utf-8');
    const portableAgent = fs.readFileSync(portableAgentPath, 'utf-8');

    for (const content of [shared, portableAgent]) {
      expect(content).toContain('github/gh-aw-firewall#5753');
      expect(content).toContain('| A14 | `unknown shorthand flag: \'d\' in -d` / `Command failed with exit code 125: docker compose up -d --pull never` |');
      expect(content).toContain('| A15 | `[WARN] Rootless artifact permission repair failed for .../sandbox/firewall/logs (exit 1)`; squid log files unreadable after ARC/DinD run; `awf logs summary` returns `Failed to load logs: EACCES` |');
      expect(content).toContain('**Fixed in PR github/gh-aw-firewall#5963**');
      expect(content).toContain('`fixArtifactPermissionsForRootless()`');
      expect(content).toContain('`applyHostPathPrefixToVolumes()`');
      expect(content).toContain('Workaround (older AWF): run `chmod -R a+rX` inside the squid container before `docker compose down`.');
      expect(content).toContain('github/gh-aw-firewall#5816, github/gh-aw-firewall#5817, github/gh-aw-firewall#5963');
      expect(content).toContain('| `unknown shorthand flag: \'d\' in -d` from `docker compose up -d` on ARC/DinD | A14 |');
      expect(content).toContain('| `Rootless artifact permission repair failed for .../sandbox/firewall/logs` on ARC/DinD | A15 |');
      expect(content).not.toMatch(/^- A15 \/ /m);
    }

    expect(source).toContain('- `unknown shorthand flag: \'d\' in -d` from `docker compose up -d` → A14 (DinD sidecar missing `docker-compose-plugin`)');
    expect(source).toContain('- `Rootless artifact permission repair failed` on ARC/DinD squid logs → A15 (`dockerHostPathPrefix` not applied to repair bind mount)');
    expect(portableAgent).toContain('- `unknown shorthand flag: \'d\' in -d` from `docker compose up -d` → A14 (DinD sidecar missing `docker-compose-plugin`)');
    expect(portableAgent).toContain('- `Rootless artifact permission repair failed` on ARC/DinD squid logs → A15 (`dockerHostPathPrefix` not applied to repair bind mount)');
  });
});
