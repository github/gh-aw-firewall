import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'pelis-agent-factory-advisor.md');
const lockPath = path.join(workflowsDir, 'pelis-agent-factory-advisor.lock.yml');

describe('pelis agent factory advisor workflow config', () => {
  it('uses automatic model selection and preserves the turn budget in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 4');
    expect(source).toContain('model: auto');
  });

  it('compiles model and turn budget into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('"agent_model":"auto"');
    expect(lock).toContain('COPILOT_MODEL: auto');
    expect(lock).toContain('GH_AW_MAX_TURNS: 4');
  });
});
