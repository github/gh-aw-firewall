import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const root = path.resolve(__dirname, '../..');
const script = path.join(__dirname, 'configure-aoai-smoke-pricing.cjs');
const original = {
  network: { isolation: true, allowDomains: ['github.com'] },
  apiProxy: { enabled: true, maxAiCredits: 10, maxCacheMisses: 5, maxRuns: 500 },
};
let work: string;
let files: string[];
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-aoai-pricing-'));
  files = [path.join(work, 'runner.json'), path.join(work, 'sandbox.json')];
  for (const file of files) fs.writeFileSync(file, JSON.stringify(original));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

test('pins confirmed deployment pricing in both configs while preserving every existing limit', () => {
  for (let repeat = 0; repeat < 2; repeat++) execFileSync(process.execPath, [script, ...files]);
  for (const file of files) {
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...original,
      apiProxy: {
        ...original.apiProxy,
        modelPricingCatalog: {
          schemaVersion: 1,
          unit: 'USD_PER_1M_TOKENS',
          catalogId: 'github/gh-aw-firewall/azure-byok-smoke',
          version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          providers: {
            copilot: { models: {
              'o4-mini-aw': { input: 1.1, cachedInput: 0.275, cacheWrite: null, output: 4.4, reasoning: 4.4 },
            } },
          },
        },
      },
    });
  }
});

test('the actual guard prices configured aliases and leaves unpriced usage unaccounted', () => {
  execFileSync(process.execPath, [script, ...files]);
  const config = JSON.parse(fs.readFileSync(files[0], 'utf8')) as { apiProxy: { modelPricingCatalog: unknown } };
  const probe = `
    const assert=require('node:assert/strict');
    const guard=require('./containers/api-proxy/guards/ai-credits-guard');
    assert.equal(guard.checkModelPricing('o4-mini-aw','copilot'),null);
    assert.equal(guard.checkModelPricing('unknown-azure-deployment','copilot'),null);
    const usage=guard.applyAiCreditsUsage({
      input_tokens:1000,cache_read_tokens:100,output_tokens:500,input_tokens_include_cache:true
    },'o4-mini-aw','copilot');
    assert(Math.abs(usage.aiCreditsThisResponse-0.32175)<1e-10);
    assert.equal(guard.applyAiCreditsUsage({
      input_tokens:1000,output_tokens:500
    },'unknown-azure-deployment','copilot'),null);
    const state=guard.getAiCreditsReflectState();
    assert.equal(state.max_ai_credits,10);
    assert.equal(state.effective_max_ai_credits,10);
  `;
  const output = execFileSync(process.execPath, ['-e', probe], {
    cwd: root,
    env: { ...process.env, AWF_MAX_AI_CREDITS: '10', AWF_MODEL_PRICING_CATALOG: JSON.stringify(config.apiProxy.modelPricingCatalog) },
    stdio: 'pipe',
  });
  const logs = output.toString().trim().split('\n').map(line => JSON.parse(line));
  expect(logs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      event: 'unknown_model_ai_credits_pricing',
      modelProvided: true,
      message: expect.stringContaining('unpriced usage is excluded'),
    }),
  ]));
  expect(logs[0]).not.toHaveProperty('model');
});

test('does not overwrite a pre-existing compiler catalog or partially mutate staged configs', () => {
  fs.writeFileSync(files[1], JSON.stringify({
    ...original, apiProxy: { ...original.apiProxy, modelPricingCatalog: { catalogId: 'compiler-owned' } },
  }));
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  const result = spawnSync(process.execPath, [script, ...files], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Refusing to replace');
  expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
});

test.each(['apikey', 'entra'])('postprocessing configures only the Azure %s smoke, idempotently', mode => {
  const input = '          cp "${RUNNER_TEMP}/gh-aw/awf-config.json" /tmp/gh-aw/awf-config.json\n';
  const workflow = `/tmp/smoke-copilot-byok-aoai-${mode}.lock.yml`;
  const patched = applyGeneralWorkflowPatches(input, workflow).content;
  expect(patched).toContain('node "${GITHUB_WORKSPACE}/scripts/ci/configure-aoai-smoke-pricing.cjs"');
  expect(applyGeneralWorkflowPatches(patched, workflow).content).toBe(patched);
  expect(applyGeneralWorkflowPatches(input, '/tmp/smoke-copilot-byok.lock.yml').content).toBe(input);
  expect(() => applyGeneralWorkflowPatches('', workflow)).toThrow('Missing AWF config staging');
});

test.each(['apikey', 'entra'])('the %s smoke uses Responses without changing the priced wire deployment', mode => {
  const name = `smoke-copilot-byok-aoai-${mode}`;
  const source = fs.readFileSync(path.join(root, `.github/workflows/${name}.md`), 'utf8');
  const lock = fs.readFileSync(path.join(root, `.github/workflows/${name}.lock.yml`), 'utf8');
  for (const content of [source.split('---')[1], lock]) {
    expect(yaml.load(content)).toMatchObject({
      env: { COPILOT_MODEL: 'o4-mini-aw', COPILOT_PROVIDER_WIRE_API: 'responses' },
    });
  }
});

test.each(['apikey', 'entra'])('the actual generated %s config stage installs pricing before AWF launches', mode => {
  const lockPath = path.join(root, `.github/workflows/smoke-copilot-byok-aoai-${mode}.lock.yml`);
  const content = fs.readFileSync(lockPath, 'utf8');
  expect(applyGeneralWorkflowPatches(content, lockPath).content).toBe(content);
  const workflow = yaml.load(content) as { jobs: { agent: { steps: { run?: string }[] } } };
  const run = workflow.jobs.agent.steps.find(step => step.run?.includes('configure-aoai-smoke-pricing.cjs'))!.run!;
  const lines = run.split('\n');
  const start = lines.findIndex(line => line.startsWith("printf '%s\\n' "));
  const end = lines.findIndex(line => line.startsWith('node "${GITHUB_WORKSPACE}/scripts/ci/configure-aoai-smoke-pricing.cjs"'));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(run.indexOf('configure-aoai-smoke-pricing.cjs')).toBeLessThan(run.indexOf('awf --config'));
  fs.mkdirSync(path.join(work, 'gh-aw'));
  const stage = lines.slice(start, end + 1).join('\n')
    .split('/tmp/gh-aw/awf-config.json').join(files[1]);
  execFileSync('bash', ['-e', '-c', stage], {
    env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: work, GH_AW_MAX_AI_CREDITS: '10' },
    stdio: 'pipe',
  });
  const runner = fs.readFileSync(path.join(work, 'gh-aw/awf-config.json'), 'utf8');
  expect(runner).toBe(fs.readFileSync(files[1], 'utf8'));
  expect(JSON.parse(runner)).toMatchObject({
    apiProxy: { maxAiCredits: 10, maxRuns: 500, maxCacheMisses: 5,
      modelPricingCatalog: { providers: { copilot: { models: { 'o4-mini-aw': { input: 1.1, output: 4.4 } } } } } },
  });
});
