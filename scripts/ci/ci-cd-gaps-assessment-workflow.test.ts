import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'ci-cd-gaps-assessment.md');
const lockPath = path.join(workflowsDir, 'ci-cd-gaps-assessment.lock.yml');

describe('ci-cd gaps assessment workflow config', () => {
  it('pins a cheaper model and turn budget in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 4');
    expect(source).toContain('model: claude-haiku-4.5');
  });

  it('compiles model and turn budget into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('"agent_model":"claude-haiku-4.5"');
    expect(lock).toContain('COPILOT_MODEL: claude-haiku-4.5');
    expect(lock).toContain('GH_AW_MAX_TURNS: 4');
  });
});
