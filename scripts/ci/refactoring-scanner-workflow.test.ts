import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'refactoring-scanner.md');
const lockPath = path.join(workflowsDir, 'refactoring-scanner.lock.yml');

describe('refactoring scanner workflow prompt', () => {
  it('pins the installer to a reviewed Copilot release instead of floating compatibility resolution', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const lock = fs.readFileSync(lockPath, 'utf-8');
    const metadataLine = lock.split('\n').find(line => line.startsWith('# gh-aw-metadata: '));

    expect(source).toContain('engine:\n  id: copilot\n  version: "1.0.98"');
    expect(JSON.parse(metadataLine!.slice('# gh-aw-metadata: '.length)).engine_versions.copilot)
      .toBe('1.0.98');
    expect(lock).toContain('run: bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.98');
    expect(lock).not.toMatch(/run: bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/install_copilot_cli\.sh"\s*\n/);
  });

  it('requires a direct noop MCP call when no issues are created', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toMatch(
      /- \*\*No significant issues found\*\*: Directly invoke the `safeoutputs\.noop` MCP tool[^\n]*Do not simulate this safe output with `bash`, `printf`, or a final text response\./,
    );
    expect(source).toMatch(
      /- \*\*All findings already tracked\*\*:[^\n]*directly invoke the `safeoutputs\.noop` MCP tool[^\n]*Do not simulate this safe output with `bash`, `printf`, or a final text response\./,
    );
  });
});
