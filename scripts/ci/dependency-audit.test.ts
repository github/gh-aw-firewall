import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

type Workflow = {
  jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
};

describe('dependency audit workflow', () => {
  it('enforces zero high and critical vulnerabilities for both packages', () => {
    const workflow = yaml.load(fs.readFileSync(
      path.join(__dirname, '../../.github/workflows/dependency-audit.yml'), 'utf8',
    )) as Workflow;

    for (const job of ['audit-main', 'audit-docs']) {
      const enforcement = workflow.jobs[job].steps.find((step) => step.name.startsWith('Enforce'))?.run;
      expect(enforcement).toContain('(.metadata.vulnerabilities.high == 0)');
      expect(enforcement).toContain('(.metadata.vulnerabilities.critical == 0)');
      expect(enforcement).toContain('npm audit advisory service unavailable after retries');
      expect(enforcement).toContain('test "$EVENT_NAME" = "pull_request"\n  exit');
      expect(enforcement).not.toContain('enforce-docs-audit');
      expect(enforcement).not.toContain('allowlist');
    }
  });
});
