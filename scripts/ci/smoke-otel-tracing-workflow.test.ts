import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const source = fs.readFileSync(path.join(workflowsDir, 'smoke-otel-tracing.md'), 'utf-8');

interface Step {
  name: string;
  run?: string;
}

const frontmatter = yaml.load(source.match(/^---\n([\s\S]*?)\n---/)![1]) as {
  steps: Step[];
  'post-steps': Step[];
};
const lock = yaml.load(fs.readFileSync(
  path.join(workflowsDir, 'smoke-otel-tracing.lock.yml'), 'utf-8',
)) as { jobs: { agent: { steps: Step[] } } };

describe.each([
  ['source', [...frontmatter.steps, ...frontmatter['post-steps']]],
  ['lock', lock.jobs.agent.steps],
] as const)('OTEL smoke %s', (_name, steps) => {
  it('uses the Jest 30 flag and propagates test failures', () => {
    const run = steps.find(step => step.name === 'Run api-proxy OTEL tests')!.run!;
    expect(run).toContain("npx jest --verbose --ci --testPathPatterns='otel' 2>&1");
    expect(run).not.toContain('--testPathPattern=');
    expect(run).not.toContain('|| true');
  });

  it('requires the implemented tracing module to be enabled', () => {
    const run = steps.find(step => step.name === 'Validate OTEL module loads')!.run!;
    expect(run).toContain('assert.equal(otel.isEnabled(), true)');
    expect(run).not.toContain('MODULE_NOT_FOUND');
  });

  it('collects fallback logs from the preserved directory without claiming collector delivery', () => {
    const run = steps.find(step => step.name === 'Collect OTEL diagnostics')!.run!;
    expect(run).toContain('/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl');
    expect(run).toContain('/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl');
    expect(run).not.toContain('/logs/api-proxy/');
    expect(run).toContain('collector delivery requires backend span evidence');
    expect(run).toContain('expected in OTLP collector mode, not proof of export');
    expect(run).not.toContain('OTEL not yet active');
  });
});

it('reports file fallback separately from collector delivery and unavailable post-step output', () => {
  expect(source).toContain('uses FileSpanExporter when no OTLP config at all');
  expect(source).toContain('post-step runs after the agent and is not available yet');
  expect(source).toContain('otherwise report it as unverified, not failed');
  expect(source).not.toContain('expected-pending during development');
});
