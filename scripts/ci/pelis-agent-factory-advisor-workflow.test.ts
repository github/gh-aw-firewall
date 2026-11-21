import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'pelis-agent-factory-advisor.md');
const lockPath = path.join(workflowsDir, 'pelis-agent-factory-advisor.lock.yml');

describe('pelis agent factory advisor workflow config', () => {
  it('uses the model router and a turn budget in source workflow', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('max-turns: 4');
    expect(source).toContain('model: router');
  });

  it('compiles model routing and turn budget into lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('GH_AW_MODEL_ROUTING_ENABLED: "true"');
    expect(lock).toContain('GH_AW_MAX_TURNS: 4');
  });
});
