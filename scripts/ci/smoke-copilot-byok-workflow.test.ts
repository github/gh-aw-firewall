import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const byokSourcePath = path.join(workflowsDir, 'smoke-copilot-byok.md');
const byokLockPaths = [
  path.join(workflowsDir, 'smoke-copilot-byok.lock.yml'),
  path.join(workflowsDir, 'smoke-copilot-byok-aoai-apikey.lock.yml'),
  path.join(workflowsDir, 'smoke-copilot-byok-aoai-entra.lock.yml'),
];

describe('smoke copilot BYOK workflow model selection', () => {
  it('pins the direct BYOK source workflow to claude-haiku-4.5', () => {
    const source = fs.readFileSync(byokSourcePath, 'utf-8');

    expect(source).toContain('COPILOT_MODEL: claude-haiku-4.5');
  });

  it.each(byokLockPaths)('forces workflow-level COPILOT_MODEL in %s', (lockPath) => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('COPILOT_MODEL: ${{ env.COPILOT_MODEL }}');
    expect(lock).not.toContain('COPILOT_MODEL: ${{ vars.GH_AW_MODEL_AGENT_COPILOT || env.COPILOT_MODEL }}');
  });
});
