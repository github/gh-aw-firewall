import * as fs from 'fs';
import * as path from 'path';

import { COPILOT_PLACEHOLDER_TOKEN } from '../../src/constants/placeholders';

const repoRoot = path.resolve(__dirname, '../..');
const sourcePath = path.join(repoRoot, '.github/workflows/smoke-nvx-copilot.md');
const lockPath = path.join(repoRoot, '.github/workflows/smoke-nvx-copilot.lock.yml');

function readWorkflow(pathname: string): string {
  return fs.readFileSync(pathname, 'utf8');
}

function nestedSmokeScript(workflow: string): string {
  const match = workflow.match(
    /cat > "\$layer_root\/usr\/local\/bin\/awf-nvx-smoke" <<'EOF'\n([\s\S]*?)\n\s*EOF/,
  );
  if (!match) {
    throw new Error('Nested NVX Copilot smoke script was not found');
  }
  return match[1];
}

describe('Smoke NVX Copilot nested authentication', () => {
  it('uses only the AWF placeholder and fixed Copilot API proxy route', () => {
    const script = nestedSmokeScript(readWorkflow(sourcePath));

    expect(script).toContain(
      `COPILOT_GITHUB_TOKEN="${COPILOT_PLACEHOLDER_TOKEN}"; export COPILOT_GITHUB_TOKEN`,
    );
    expect(script).toContain('COPILOT_TOKEN="$COPILOT_GITHUB_TOKEN"; export COPILOT_TOKEN');
    expect(script).toContain(
      'COPILOT_PROVIDER_API_KEY="$COPILOT_GITHUB_TOKEN"; export COPILOT_PROVIDER_API_KEY',
    );
    expect(script).toContain(
      'COPILOT_API_URL="http://172.30.0.30:10002"; export COPILOT_API_URL',
    );
    expect(script).toContain(
      'COPILOT_PROVIDER_BASE_URL="$COPILOT_API_URL"; export COPILOT_PROVIDER_BASE_URL',
    );
    expect(script).toContain('COPILOT_OFFLINE=true; export COPILOT_OFFLINE');
    expect(script).toContain('nc -z -w 5 172.30.0.30 10002');
    expect(script).not.toContain('COPILOT_API_KEY=');
    expect(script).not.toContain('$GH_TOKEN');
    expect(script).not.toContain('$GITHUB_TOKEN');
    expect(script).not.toContain('${{');
  });

  it('keeps real GitHub and provider credentials forbidden in the nested guest', () => {
    const script = nestedSmokeScript(readWorkflow(sourcePath));

    expect(script).toContain(
      "env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|COPILOT_API_KEY)='",
    );
    expect(script).toContain(
      'real credential value reached the NVX guest via COPILOT_GITHUB_TOKEN',
    );
    expect(script).toContain(
      'real credential value reached the NVX guest via COPILOT_PROVIDER_API_KEY',
    );
  });

  it('keeps the compiled workflow aligned with the nested auth boundary', () => {
    const lock = readWorkflow(lockPath);

    expect(lock).toContain(COPILOT_PLACEHOLDER_TOKEN);
    expect(lock).toContain('COPILOT_TOKEN=\\"$COPILOT_GITHUB_TOKEN\\"; export COPILOT_TOKEN');
    expect(lock).toContain(
      'COPILOT_PROVIDER_API_KEY=\\"$COPILOT_GITHUB_TOKEN\\"; export COPILOT_PROVIDER_API_KEY',
    );
    expect(lock).toContain('COPILOT_API_URL=\\"http://172.30.0.30:10002\\"; export COPILOT_API_URL');
    expect(lock).toContain(
      'COPILOT_PROVIDER_BASE_URL=\\"$COPILOT_API_URL\\"; export COPILOT_PROVIDER_BASE_URL',
    );
    expect(lock).toContain('nc -z -w 5 172.30.0.30 10002');
    expect(lock).not.toContain('COPILOT_API_KEY=\\"dummy-byok-key-for-offline-mode\\"');
  });
});
