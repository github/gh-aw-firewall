import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

function readWorkflow(name: string): { source: string; lock: string } {
  return {
    source: fs.readFileSync(path.join(workflowsDir, `${name}.md`), 'utf8'),
    lock: fs.readFileSync(path.join(workflowsDir, `${name}.lock.yml`), 'utf8'),
  };
}

describe('Copilot automatic model selection', () => {
  it.each([
    'ci-cd-gaps-assessment',
    'contribution-check',
    'doc-maintainer',
    'export-audit',
    'network-isolation-test',
    'pr-sous-chef',
    'test-hard-cap-ai-credits',
  ])('uses auto in the source and compiled primary agent for %s', name => {
    const { source, lock } = readWorkflow(name);
    const frontmatter = yaml.load(source.split(/^---\r?$/m)[1]) as {
      model?: string; engine: { id: string; model?: string };
    };
    expect(frontmatter.engine.id).toBe('copilot');
    expect(frontmatter.model ?? frontmatter.engine.model).toBe('auto');
    expect(lock).toContain('"agent_model":"auto"');
    expect(lock).toContain('GH_AW_INFO_MODEL: "auto"');
    expect(lock).toContain('COPILOT_MODEL: auto');
    expect(lock).not.toContain('GH_AW_INFO_MODEL_COSTS:');
  });

  it.each([
    'smoke-enclave-issues-read',
    'smoke-enclave-dynamic-issues-read',
  ])('uses auto in the source and compiled enclave for %s', name => {
    const { source, lock } = readWorkflow(name);
    const frontmatter = yaml.load(source.split(/^---\r?$/m)[1]) as {
      enclaves: Array<{ agent: { model: string } }>;
    };
    expect(frontmatter.enclaves).toHaveLength(1);
    expect(frontmatter.enclaves[0].agent.model).toBe('auto');
    const match = lock.match(/\\"enclaves\\":(\[.+?\]),\\"container\\"/);
    expect(match).not.toBeNull();
    const enclaves = JSON.parse(match![1].replace(/\\"/g, '"')) as
      Array<{ agent: { model: string } }>;
    expect(enclaves).toHaveLength(1);
    expect(enclaves[0].agent.model).toBe('auto');
  });
});

describe('Copilot model routing', () => {
  it.each([
    'auth-doctor-updater',
    'claude-token-optimizer',
    'config-consistency-auditor',
    'copilot-token-optimizer',
    'copilot-token-usage-analyzer',
    'dependency-security-monitor',
    'duplicate-code-detector',
    'issue-duplication-detector',
    'pelis-agent-factory-advisor',
    'refactoring-scanner',
    'security-guard',
    'security-review',
  ])('routes the primary agent model for %s', name => {
    const { source, lock } = readWorkflow(name);
    const frontmatter = yaml.load(source.split(/^---\r?$/m)[1]) as { model?: string };
    expect(frontmatter.model).toBe('router');
    expect(lock).toContain('GH_AW_MODEL_ROUTING_ENABLED: "true"');
    expect(lock).toContain('\\"experimental\\":{\\"modelRouting\\":true}');
  });
});
