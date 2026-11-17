import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

type Workflow = {
  jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
};

describe('dependency audit workflow', () => {
  it('enforces scoped acceptances and rejects all other high and critical findings', () => {
    const workflow = yaml.load(fs.readFileSync(
      path.join(__dirname, '../../.github/workflows/dependency-audit.yml'), 'utf8',
    )) as Workflow;

    for (const [job, script, report] of [
      ['audit-main', 'scripts/ci/enforce-npm-audit.ts', 'npm-audit-main.json'],
      ['audit-docs', '../scripts/ci/enforce-npm-audit.ts', 'npm-audit-docs.json'],
    ]) {
      const enforcement = workflow.jobs[job].steps.find((step) => step.name.startsWith('Enforce'))?.run;
      expect(enforcement?.match(/npx --yes tsx@4\.23\.15/g)).toHaveLength(2);
      expect(enforcement).toContain(`${script} \\\n  --check-allowlist audit-allowlist.json`);
      expect(enforcement).toContain(`${script} \\\n  ${report} audit-allowlist.json`);
      expect(enforcement).toContain('npm audit advisory service unavailable after retries');
      expect(enforcement).toContain('test "$EVENT_NAME" = "pull_request"\n  exit');
      expect(enforcement).not.toContain('enforce-docs-audit');
      expect(enforcement?.indexOf('--check-allowlist')).toBeLessThan(
        enforcement?.indexOf("if jq -e '.error'") ?? -1,
      );
    }
  });
});
