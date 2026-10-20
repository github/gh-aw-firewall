import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import proxyRetired from '../../containers/api-proxy/model-information.retired.generated.json';

const root = path.resolve(__dirname, '../..');
const compiler = path.join(__dirname, 'compile.cjs');
const { latestTimestamp } = require('./compile.cjs');
const run = (...flags: string[]) => {
  const result = spawnSync(process.execPath, [compiler, ...flags], {
    cwd: root, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

describe('maintained model compilation', () => {
  it('checks repeatable generated outputs without refreshing timestamps', () => {
    expect(run('--check')).toMatch(/Checked model catalogue/);
    const first = fs.readFileSync(path.join(root, 'shared/model-information/manifest.generated.json'));
    run('--check');
    expect(fs.readFileSync(path.join(root, 'shared/model-information/manifest.generated.json'))).toEqual(first);
  });

  it('keeps legacy decisions in isolated compatibility projections', () => {
    const { supported, retired, suggestionOrder } = require('../../src/model-information.compat.generated.json');
    const { testHelpers } = require('../../src/copilot-model');
    expect(new Set(supported)).toEqual(testHelpers.supportedCopilotModels);
    expect([...supported].sort()).toEqual([...suggestionOrder].sort());
    expect(new Set(suggestionOrder).size).toBe(suggestionOrder.length);
    expect(retired).toEqual({ 'gpt-5-codex': 'gpt-5.3-codex' });
    expect(retired).toEqual(proxyRetired);
    const pricing = require('../../containers/api-proxy/model-information.pricing.generated.json');
    const legacy = require('../../containers/api-proxy/ai-credits-pricing');
    expect(pricing).toEqual(JSON.parse(JSON.stringify(legacy)));
    expect(fs.readFileSync(path.join(root, 'docs/model-api-mapping.json')))
      .toEqual(fs.readFileSync(path.join(root, 'containers/api-proxy/model-api-mapping.json')));
  });

  it('includes schema and compiler version in revision', () => {
    const manifest = require('../../shared/model-information/manifest.generated.json');
    const catalogue = require('../../shared/model-information/catalog.generated.json');
    expect(manifest.catalogRevision).toBe(catalogue.catalogRevision);
    expect(manifest.compilerVersion).toBe(3);
    expect(manifest.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.generatedAt).toBe(manifest.generatedAt);
  });

  it('uses the latest reviewed timestamp across all provenance sources', () => {
    expect(latestTimestamp([
      { at: '2026-10-19T17:20:11-07:00' },
      { at: '2026-10-21T00:00:00Z' },
    ])).toBe('2026-10-21T00:00:00.000Z');
  });

  it('stages named pricing and routing corrections without activating them', () => {
    const baseline = require('../../shared/model-information/catalog.generated.json');
    const target = require('../../shared/model-information/target.generated.json');
    const delta = require('../../shared/model-information/baseline-to-target.generated.json');
    const importedBaseline = baseline.models.find((model: { identity: { key: string } }) =>
      model.identity.key === 'openai/gpt-5.5');
    const lookup = (key: string) => target.models.find((model: { identity: { key: string } }) =>
      model.identity.key === key);
    expect(baseline.models.some((model: { identity: { key: string } }) =>
      model.identity.key === 'copilot/gemini-3.8-flash')).toBe(false);
    expect(lookup('copilot/gemini-3.8-flash').tariffs[0].effectiveUntil).toBe('2027-01-01T00:00:00Z');
    expect(lookup('copilot/gemini-3.8-flash').tariffs[0].components.cacheWrite.price)
      .toEqual({ unavailable: true });
    const long = lookup('copilot/grok-4.7').tariffs.find((tier: { tier: string }) =>
      tier.tier === 'long_context');
    expect(long.promptTokensAbove).toBe(200000);
    expect(lookup('openai/gpt-6.1-sol').reasoning.selectableEfforts).not.toContain('none');
    expect(lookup('openai/gpt-5.6-sol').reasoning.selectableEfforts).toContain('none');
    expect(lookup('openai/gpt-5.6-cyber').reasoning.support).toBe('unknown');
    expect(lookup('anthropic/claude-opus-4.6').reasoning.selectableEfforts).not.toContain('xhigh');
    expect(lookup('anthropic/claude-opus-4.8').reasoning.selectableEfforts).toContain('xhigh');
    expect(lookup('anthropic/claude-fable-5.1').reasoning.selectableEfforts).toContain('xhigh');
    expect(lookup('anthropic/claude-mythos-preview').reasoning.selectableEfforts).not.toContain('xhigh');
    expect(delta.mapping.target.providers.anthropic.models.find(
      (entry: { family: string }) => entry.family === 'claude-mythos-preview',
    ).routing.contextWindowTokens).toBe(1000000);
    expect(delta.activation).toMatch(/staged/);
    expect(delta.mapping.target.providers.openai.models.find((entry: { family: string }) =>
      entry.family === 'gpt-5.5').routingPatterns).not.toContain('gpt-5.5-pro');
    const opusFour = delta.mapping.target.providers.anthropic.models.find(
      (entry: { family: string }) => entry.family === 'claude-opus-4');
    const opusFourSix = delta.mapping.target.providers.anthropic.models.find(
      (entry: { family: string }) => entry.family === 'claude-opus-4-6');
    expect(opusFour.routing.reasoningEfforts).toContain('xhigh');
    expect(opusFourSix.routing.reasoningEfforts).not.toContain('xhigh');
    const importedTarget = lookup('openai/gpt-5.5');
    expect(importedTarget.importedPricing).toEqual(importedBaseline.importedPricing);
    expect(importedTarget.reasoning.selectableEfforts).toContain('xhigh');
    const importedDifference = delta.differences.find(
      (difference: { key: string }) => difference.key === 'openai/gpt-5.5',
    );
    expect(importedDifference.baseline).toEqual(importedBaseline);
    expect(importedDifference.target).toEqual(importedTarget);
    expect(delta.differences).toContainEqual(expect.objectContaining({
      key: 'copilot/claude-opus-5-5',
      baseline: expect.any(Object),
      target: null,
    }));
  });

  it('rejects invalid cross-file records with source diagnostics', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-sources-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'copilot-main.json');
      const copy = JSON.parse(fs.readFileSync(file, 'utf8'));
      copy.models[0].lifecycle.replacement = 'copilot/does-not-exist';
      fs.writeFileSync(file, JSON.stringify(copy));
      expect(() => run('--check', `--source-dir=${temp}`))
        .toThrow(/Unresolved replacement: copilot\/does-not-exist/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(['missing provenance', 'missing timestamp', 'invalid timestamp', 'non-string timestamp'])(
    'rejects %s in lifecycle compatibility provenance before deriving timestamps',
    kind => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-provenance-'));
      try {
        fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
        const file = path.join(temp, 'lifecycle-compatibility.json');
        const source = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (kind === 'missing provenance') delete source.provenance;
        if (kind === 'missing timestamp') delete source.provenance.at;
        if (kind === 'invalid timestamp') source.provenance.at = 'not-a-timestamp';
        if (kind === 'non-string timestamp') source.provenance.at = 0;
        fs.writeFileSync(file, JSON.stringify(source));
        const result = spawnSync(process.execPath, [compiler, '--check', `--source-dir=${temp}`], {
          cwd: root, encoding: 'utf8',
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('lifecycle-compatibility.json: expected reviewed provenance with a valid at timestamp');
        expect(result.stderr).not.toMatch(/RangeError|TypeError|stale; run/);
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it.each(['duplicate', 'missing', 'unavailable'])('rejects %s suggestion-order metadata', kind => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-order-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'lifecycle-compatibility.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (kind === 'duplicate') source.suggestionOrder[1] = source.suggestionOrder[0];
      if (kind === 'missing') source.suggestionOrder.pop();
      if (kind === 'unavailable') source.suggestionOrder[1] = 'grok-4.7';
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`))
        .toThrow(/ordering cannot author availability/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(['native-api', 'copilot-api', 'deployment'])('does not broaden %s availability into CLI support', scope => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-scope-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'copilot-main.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      const availability = source.models[0].availability[0];
      if (scope === 'deployment') availability.scope.deployment = 'private';
      else availability.scope.channel = scope;
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`))
        .toThrow(/ordering cannot author availability/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('does not project another provider retirement into Copilot guards', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-retirement-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'copilot-main.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      const retired = structuredClone(source.models.find(
        (model: { lifecycle: { status: string } }) => model.lifecycle.status === 'retired',
      ));
      retired.identity.provider = 'other';
      retired.identity.key = `other/${retired.identity.rawId}`;
      source.models.push(retired);
      fs.writeFileSync(file, JSON.stringify(source));
      const result = spawnSync(process.execPath, [compiler, '--check', `--source-dir=${temp}`], {
        cwd: root, encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('catalog.generated.json: stale');
      expect(result.stderr).not.toContain('model-information.compat.generated.json: stale');
      expect(result.stderr).not.toContain('model-information.retired.generated.json: stale');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each([
    ['normalized collision', (models: any[]) => {
      const clone = structuredClone(models[0]);
      clone.identity.rawId = clone.identity.rawId.replace(/[.-]/g, '_');
      if (clone.identity.rawId === models[0].identity.rawId) {
        clone.identity.rawId = clone.identity.rawId.toUpperCase();
      }
      clone.identity.key = `copilot/${clone.identity.rawId}`;
      models.push(clone);
    }, /Duplicate normalized exact key/],
    ['missing source provenance', (_models: any[], source: any) => {
      delete source.provenance;
    }, /expected schemaVersion, reviewed provenance and models/],
  ])('rejects %s in an assembled source set', (_name, change, diagnostic) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-sources-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'copilot-main.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      change(source.models, source);
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`)).toThrow(diagnostic);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects equal-specificity mapping conflicts before generating copies', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-mapping-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'mapping.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      source.mapping.providers.openai.models.push({
        family: 'collision', patterns: ['gpt-6-astra*'], endpoints: ['responses'],
      });
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`)).toThrow(/mapping.json: openai: conflicting equal-specificity pattern gpt-6-astra/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects conflicting routing metadata for equal routing patterns', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-routing-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'mapping.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      source.mapping.providers.openai.models.push({
        family: 'routing-collision', patterns: ['other*'], routingPatterns: ['gpt-5.4'],
        endpoints: ['responses'],
        routing: { reasoningEfforts: ['low'], contextWindowTokens: 400000 },
      });
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`))
        .toThrow(/mapping.json: openai: conflicting routing pattern gpt-5.4/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('detects stale projections when reviewed source metadata changes', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-stale-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'target.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      source.provenance.revision += '-reviewed';
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`))
        .toThrow(/stale; run npm run models:generate/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('resolves generated proxy assets independently of repository shared modules', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'containers/api-proxy/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/model-information\.pricing\.generated\.json model-information\.retired\.generated\.json/);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-assets-'));
    try {
      fs.mkdirSync(path.join(temp, 'guards'));
      for (const file of ['model-information.pricing.generated.json',
        'model-information.retired.generated.json', 'model-api-mapping.json', 'model-api-mapping.js',
        'guards/retired-model-guard.js', 'logging.js']) {
        fs.copyFileSync(path.join(root, 'containers/api-proxy', file), path.join(temp, file));
      }
      const output = execFileSync(process.execPath, ['-e',
        "const assert=require('node:assert/strict');const m=require('./model-api-mapping');assert(m.lookupModelEndpoints('gpt-5.5','openai'));const g=require('./guards/retired-model-guard');assert.equal(g.getRetiredModelBlockState('GPT-5-CODEX').suggestion,'gpt-5.3-codex');assert.equal(g.getRetiredModelBlockState('GPT_5_CODEX'),null);"],
      { cwd: temp, encoding: 'utf8' });
      expect(output).toBe('');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('loads the compiled and bundled host lifecycle reader outside the source tree', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-host-lifecycle-'));
    try {
      const compiled = path.join(temp, 'compiled');
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
        '--target', 'es2020', '--module', 'commonjs', '--resolveJsonModule',
        '--esModuleInterop', '--skipLibCheck', '--outDir', compiled,
        path.join(root, 'src/copilot-model.ts')], { cwd: root, encoding: 'utf8' });
      const verify = (entry: string) => execFileSync(process.execPath, ['-e',
        `const assert=require('node:assert/strict');const {validateCopilotModel:v}=require(${JSON.stringify(entry)});assert.deepEqual(v(' GPT_5_3_CODEX '),{valid:true,resolvedModel:'gpt-5.3-codex'});assert.equal(v('GPT_5_CODEX').reason,'retired');assert(v('gpt-54-mini').message.includes("'gpt-5.4-mini'"));assert.equal(v('grok-4.7').valid,false);`],
      { cwd: temp, encoding: 'utf8' });
      expect(verify('./compiled/copilot-model.js')).toBe('');
      buildSync({
        entryPoints: [path.join(compiled, 'copilot-model.js')],
        bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temp, 'bundle.js'),
      });
      fs.rmSync(compiled, { recursive: true, force: true });
      expect(verify('./bundle.js')).toBe('');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
