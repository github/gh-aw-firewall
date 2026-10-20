import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
const compiler = path.join(__dirname, 'compile.cjs');
const run = (flag: string) => execFileSync(process.execPath, [compiler, flag], {
  cwd: root, encoding: 'utf8',
});

describe('maintained model compilation', () => {
  it('checks repeatable generated outputs without refreshing timestamps', () => {
    expect(run('--check')).toMatch(/Checked model catalogue/);
    const first = fs.readFileSync(path.join(root, 'shared/model-information/manifest.generated.json'));
    run('--check');
    expect(fs.readFileSync(path.join(root, 'shared/model-information/manifest.generated.json'))).toEqual(first);
  });

  it('keeps legacy decisions in isolated compatibility projections', () => {
    const { supported, retired } = require('../../src/model-information.compat.generated.json');
    const { testHelpers } = require('../../src/copilot-model');
    expect(new Set(supported)).toEqual(testHelpers.supportedCopilotModels);
    expect(retired).toEqual({ 'gpt-5-codex': 'gpt-5.3-codex' });
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
    expect(manifest.compilerVersion).toBe(1);
    expect(manifest.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.generatedAt).toBe(manifest.generatedAt);
  });

  it('stages named pricing and routing corrections without activating them', () => {
    const baseline = require('../../shared/model-information/catalog.generated.json');
    const target = require('../../shared/model-information/target.generated.json');
    const delta = require('../../shared/model-information/baseline-to-target.generated.json');
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
    expect(delta.activation).toMatch(/staged/);
    expect(delta.mapping.target.providers.openai.models.find((entry: { family: string }) =>
      entry.family === 'gpt-5.5').routingPatterns).not.toContain('gpt-5.5-pro');
  });

  it('rejects invalid cross-file records with source diagnostics', () => {
    const file = path.join(root, 'shared/model-information/sources/openai.json');
    const original = fs.readFileSync(file, 'utf8');
    const copy = JSON.parse(original);
    copy.models[0].lifecycle.replacement = 'copilot/does-not-exist';
    try {
      fs.writeFileSync(file, JSON.stringify(copy));
      expect(() => run('--check')).toThrow(/Unresolved replacement: copilot\/does-not-exist/);
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  it('resolves generated proxy assets independently of repository shared modules', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-assets-'));
    try {
      for (const file of ['model-information.pricing.generated.json',
        'model-information.retired.generated.json', 'model-api-mapping.json']) {
        fs.copyFileSync(path.join(root, 'containers/api-proxy', file), path.join(temp, file));
      }
      const output = execFileSync(process.execPath, ['-e',
        "const fs=require('fs');for(const file of fs.readdirSync('.'))require('./'+file);"],
      { cwd: temp, encoding: 'utf8' });
      expect(output).toBe('');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
