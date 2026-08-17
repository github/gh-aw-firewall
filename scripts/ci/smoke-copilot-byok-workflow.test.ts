import * as fs from 'fs';
import * as path from 'path';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const byokSourcePath = path.join(workflowsDir, 'smoke-copilot-byok.md');
const byokLockPaths = [
  path.join(workflowsDir, 'smoke-copilot-byok.lock.yml'),
  path.join(workflowsDir, 'smoke-copilot-byok-aoai-apikey.lock.yml'),
  path.join(workflowsDir, 'smoke-copilot-byok-aoai-entra.lock.yml'),
];
const entraLockPath = path.join(workflowsDir, 'smoke-copilot-byok-aoai-entra.lock.yml');

describe('smoke copilot BYOK workflow model selection', () => {
  it('pins the direct BYOK source workflow to claude-haiku-4.5', () => {
    const source = fs.readFileSync(byokSourcePath, 'utf-8');

    expect(source).toContain('COPILOT_MODEL: claude-haiku-4.5');
  });

  it.each(byokLockPaths)('sets workflow-level COPILOT_MODEL env in %s', (lockPath) => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    // The compiled lock file should define COPILOT_MODEL at the workflow env level
    // (pinned model from the source .md) and use vars-based selection in the agent job
    expect(lock).toMatch(/^\s+COPILOT_MODEL:\s*(?:claude-haiku-4\.5|o4-mini-aw)\s*$/m);
    expect(lock).not.toMatch(/COPILOT_MODEL:\s*\$\{\{\s*vars\.GH_AW_MODEL_AGENT_COPILOT\s*\|\|\s*env\.COPILOT_MODEL\s*\}\}\s*/);
  });

  it('excludes Azure OIDC identifiers from the Entra agent environment', () => {
    const lock = fs.readFileSync(entraLockPath, 'utf-8');
    expect(lock).toContain('--exclude-env AWF_AUTH_AZURE_CLIENT_ID');
    expect(lock).toContain('--exclude-env AWF_AUTH_AZURE_TENANT_ID');

    const compilerOutput = lock
      .replace(' --exclude-env AWF_AUTH_AZURE_CLIENT_ID', '')
      .replace(' --exclude-env AWF_AUTH_AZURE_TENANT_ID', '');
    const { content: postprocessedLock } = applyGeneralWorkflowPatches(
      compilerOutput,
      entraLockPath
    );

    expect(postprocessedLock).toContain('--exclude-env AWF_AUTH_AZURE_CLIENT_ID');
    expect(postprocessedLock).toContain('--exclude-env AWF_AUTH_AZURE_TENANT_ID');
    expect(postprocessedLock).toMatch(
      /--exclude-env ACTIONS_ID_TOKEN_REQUEST_URL --exclude-env AWF_AUTH_AZURE_CLIENT_ID --exclude-env AWF_AUTH_AZURE_TENANT_ID/
    );
  });
});
