import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import legacyPricingFixture from './fixtures/legacy-ai-credits-pricing.v1.json';

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
const copyLegacyPricingProjections = (directory: string) => {
  const proxy = path.join(directory, 'containers/api-proxy');
  fs.mkdirSync(proxy, { recursive: true });
  fs.copyFileSync(path.join(root, 'containers/api-proxy/ai-credits-pricing.js'),
    path.join(proxy, 'ai-credits-pricing.js'));
};

describe('maintained model compilation', () => {
  it('checks repeatable generated outputs without refreshing timestamps', () => {
    expect(run('--check')).toMatch(/Checked model catalogue/);
    expect(run('--check', `--root=${root}`)).toMatch(/Checked model catalogue/);
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
    expect(retired).toEqual(require('../../containers/api-proxy/model-information.retired.generated.json'));
    const legacy = require('../../containers/api-proxy/ai-credits-pricing');
    expect(Object.fromEntries(Object.keys(legacyPricingFixture).map(key => [key, legacy[key]])))
      .toEqual(legacyPricingFixture);
    expect(fs.readFileSync(path.join(root, 'docs/model-api-mapping.json')))
      .toEqual(fs.readFileSync(path.join(root, 'containers/api-proxy/model-api-mapping.json')));
  });

  it('projects only original reviewed identities, without imports or staged target changes', () => {
    const naming = require('../../shared/model-information/naming.generated.json');
    const sourceDir = path.join(root, 'shared/model-information/sources');
    const sources = fs.readdirSync(sourceDir).sort().map(file =>
      JSON.parse(fs.readFileSync(path.join(sourceDir, file), 'utf8')))
      .filter(source => Array.isArray(source.models));
    const identities = sources.flatMap(source => source.models.map(
      (model: { identity: unknown }) => ({ identity: model.identity }),
    )).sort((a, b) => a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
    expect(naming.models).toEqual(identities);
    expect(naming.rules).toEqual(sources.flatMap(source => source.rules || []));
    const bytes = fs.readFileSync(path.join(root, 'shared/model-information/naming.generated.json'));
    for (const file of ['containers/api-proxy/model-information.naming.generated.json',
      'src/model-information.naming.generated.json']) {
      expect(fs.readFileSync(path.join(root, file))).toEqual(bytes);
    }
    for (const file of ['identity.js', 'identity.d.ts', 'resolution.js', 'resolution.d.ts', 'eligibility.js', 'eligibility.d.ts',
      'harness-observation.js', 'harness-observation.d.ts']) {
      const shared = fs.readFileSync(path.join(root, 'shared/model-information', file));
      expect(fs.readFileSync(path.join(root, 'src/model-information-contract', file))).toEqual(shared);
      expect(fs.readFileSync(path.join(root, 'containers/api-proxy/catalogue-contract', file))).toEqual(shared);
    }
  });

  it('projects exact canonical harness records without synthesizing family floors', () => {
    const projected = require('../../src/model-information.eligibility.generated.json');
    const catalogue = require('../../shared/model-information/catalog.generated.json');
    expect(projected.models).toEqual(catalogue.models.filter((model: any) => model.harnesses?.length)
      .map((model: any) => ({ identity: model.identity, harnesses: model.harnesses })));
    expect(require('../../containers/api-proxy/model-information.eligibility.generated.json')).toEqual(projected);
  });

  it('projects exact Decisions protocols once across baseline, target, docs, runtime and publication', () => {
    const source = require('../../shared/model-information/sources/decisions.json');
    const baseline = require('../../shared/model-information/catalog.generated.json');
    const target = require('../../shared/model-information/target.generated.json');
    const mapping = require('../../docs/model-api-mapping.json');
    const stagedMapping = require('../../shared/model-information/baseline-to-target.generated.json').mapping;
    const { buildSnapshot } = require('../../shared/model-information/publication.v2.cjs');
    const publication = JSON.parse(buildSnapshot(baseline, 'a'.repeat(40), source.provenance.at));
    for (const model of source.models) {
      for (const catalogue of [baseline, target, publication]) {
        expect(catalogue.models.find((item: any) => item.identity.key === model.identity.key).protocols)
          .toEqual(model.protocols);
      }
      for (const projected of [mapping, stagedMapping.baseline, stagedMapping.target]) {
        const provider = projected.providers[model.identity.provider];
        expect(provider.modelProtocols[model.identity.rawId]).toEqual(model.protocols);
        expect(provider.endpoints.decisions).toMatchObject({
          path: '/v1/decisions', basePath: '/v1', resourcePath: '/decisions',
        });
        expect(provider.models.every((entry: any) => !entry.endpoints.includes('decisions'))).toBe(true);
      }
    }
    expect(mapping.providers.copilot.modelProtocols['gpt-6-luna']).toBeUndefined();
    expect(mapping.providers.openai.modelProtocols['gpt-6-luna-decisions']).toBeUndefined();
    expect(mapping.providers.copilot.endpoints.decisions.authentication.restriction)
      .toContain('PAT rejection is observed, not lack of model support');
    expect(require('../../containers/api-proxy/model-api-mapping.json')).toEqual(mapping);
    expect(baseline.models.find((item: any) => item.identity.key === 'copilot/gpt-6-luna').protocols)
      .toBeUndefined();
    const imported = require('../../shared/model-information/imported/legacy-models-dev.snapshot.v1.json');
    expect(baseline.models.filter((item: any) => item.identity.key === 'openai/gpt-6-luna')).toHaveLength(1);
    expect(baseline.models.find((item: any) => item.identity.key === 'openai/gpt-6-luna').importedPricing)
      .toEqual(imported.models.find((item: any) => item.identity.key === 'openai/gpt-6-luna').importedPricing);
    expect(publication.models.find((item: any) => item.identity.key === 'openai/gpt-6-luna').importedPricing)
      .toBeUndefined();
  });

  it('rejects maintained overlays rather than reattributing existing model evidence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-duplicate-protocol-source-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), directory, { recursive: true });
      const source = JSON.parse(fs.readFileSync(path.join(directory, 'decisions.json'), 'utf8'));
      const maintained = require('../../shared/model-information/sources/copilot-main.json').models[0];
      source.models.push({ ...maintained, protocols: source.models[1].protocols });
      fs.writeFileSync(path.join(directory, 'decisions.json'), JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${directory}`))
        .toThrow(/maintained sources: Duplicate exact key/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('projects the reviewed finite accounting families without authorizing additional model facts', () => {
    const naming = require('../../shared/model-information/naming.generated.json');
    const catalogue = require('../../shared/model-information/catalog.generated.json');
    const members = naming.models.filter((model: { identity: { family?: string } }) => model.identity.family);
    expect(naming.models).toHaveLength(58);
    expect(members).toHaveLength(22);
    expect(new Set(members.map((model: { identity: { family: string } }) => model.identity.family)).size).toBe(9);
    expect(naming.rules).toEqual([]);
    for (const member of members) {
      expect(member.identity.provider).toBe('copilot');
      expect(catalogue.models.find((model: { identity: { key: string } }) =>
        model.identity.key === member.identity.key).identity).toEqual(member.identity);
    }
    const scoped = { provider: 'copilot', channel: 'copilot-api' };
    const { resolveIdentity } = require('../../shared/model-information/resolution');
    const withoutFamilies = { ...naming, models: naming.models.map(
      (model: { identity: { family?: string } }) => {
        const { family, ...identity } = model.identity;
        return { identity };
      },
    ) };
    for (const model of naming.models) {
      for (const requested of [model.identity.rawId, `copilot/${model.identity.rawId}?effort=high`]) {
        const before = resolveIdentity(requested, scoped, withoutFamilies);
        const after = resolveIdentity(requested, scoped, naming);
        const { family, identity, ...resolved } = after;
        const { family: identityFamily, ...originalIdentity } = identity;
        expect({ ...resolved, identity: originalIdentity }).toEqual(before);
      }
    }
  });

  it('packages dependency-free eligibility for a standalone proxy context', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eligibility-package-'));
    try {
      const fixturePath = fs.realpathSync(directory);
      const checkoutPath = fs.realpathSync(root);
      expect(fixturePath).not.toBe(checkoutPath);
      expect(fixturePath.startsWith(checkoutPath + path.sep)).toBe(false);
      fs.copyFileSync(path.join(root, 'containers/api-proxy/catalogue-contract/eligibility.js'),
        path.join(directory, 'eligibility.js'));
      expect(execFileSync(process.execPath, ['-e',
        "const assert=require('node:assert/strict');const {evaluateEligibility:e}=require('./eligibility');const r=e({identity:{key:'copilot/test',provider:'copilot',rawId:'test',lookupId:'test'},scope:{provider:'copilot',channel:'copilot-api'}});assert.equal(r.admitted,true);assert.equal(r.harness,'unconstrained');assert(Object.isFrozen(r));"],
      { cwd: directory, encoding: 'utf8' })).toBe('');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('packages host and proxy harness observation assets without source-relative imports', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-observation-package-'));
    try {
      fs.mkdirSync(path.join(directory, 'catalogue-contract'));
      for (const file of ['harness-observation.js', 'eligibility.js']) {
        fs.copyFileSync(path.join(root, 'containers/api-proxy/catalogue-contract', file),
          path.join(directory, 'catalogue-contract', file));
      }
      fs.copyFileSync(path.join(root, 'containers/api-proxy/harness-observation.js'),
        path.join(directory, 'harness-observation.js'));
      buildSync({
        entryPoints: [path.join(root, 'src/harness-observation.ts')],
        outfile: path.join(directory, 'host.js'), bundle: true, platform: 'node', format: 'cjs',
      });
      expect(execFileSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const host = require('./host');
        const env = host.harnessProxyEnvironment({agentCommand:'copilot --model x', containerRuntime:'cloud-hypervisor'});
        assert.equal(env.AWF_SELECTED_HARNESS, 'copilot-cli');
        assert.match(env.AWF_HARNESS_ENVIRONMENT, /^cloud-hypervisor:/);
        const contract = require('./catalogue-contract/harness-observation');
        const context = {environment:env.AWF_HARNESS_ENVIRONMENT,name:'copilot-cli',binary:'copilot'};
        const report = contract.parseProbe(context,{exitCode:0,stdout:'/bin/copilot\\n1.2.3\\n'});
        assert.equal(report.status, 'observed');
        assert.equal(contract.eligibilityEvidence(report,{provider:'openai',channel:'native-api'}).observations[0].version,'1.2.3');
        Object.assign(process.env, env);
        assert.equal(require('./harness-observation').readHarnessObservation().status, 'unavailable');
      `], { cwd: directory, encoding: 'utf8' })).toBe('');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('includes schema and compiler version in revision', () => {
    const manifest = require('../../shared/model-information/manifest.generated.json');
    const catalogue = require('../../shared/model-information/catalog.generated.json');
    expect(manifest.catalogRevision).toBe(catalogue.catalogRevision);
    expect(manifest.compilerVersion).toBe(8);
    expect(manifest.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.generatedAt).toBe(manifest.generatedAt);
    expect(manifest.sourceFiles).toEqual(expect.arrayContaining([
      'containers/api-proxy/models.dev.catalog.json',
      'shared/model-information/imported/legacy-models-dev.metadata.json',
    ]));
    expect(manifest.sourceFiles).not.toContain('shared/model-information/imported/legacy-models-dev.snapshot.v1.json');
  });

  it('updates active maintained pricing from canonical sources without editing the historical table', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-staged-price-'));
    try {
      for (const directory of ['scripts/model-information', 'shared/model-information']) {
        fs.cpSync(path.join(root, directory), path.join(temp, directory), { recursive: true });
      }
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
      for (const directory of ['src', 'docs']) fs.mkdirSync(path.join(temp, directory));
      const rawPath = path.join(temp, 'containers/api-proxy/models.dev.catalog.json');
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.copyFileSync(path.join(root, 'containers/api-proxy/models.dev.catalog.json'), rawPath);
      copyLegacyPricingProjections(temp);
      const sourcePath = path.join(temp, 'shared/model-information/sources/copilot-main.json');
      const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      const model = source.models.find((entry: { identity: { rawId: string } }) =>
        entry.identity.rawId === 'gpt-5-codex-mini');
      model.tariffs[0].components.input.price = '9.0000000000000000000000000001';
      const sol = source.models.find((entry: { identity: { rawId: string } }) =>
        entry.identity.rawId === 'gpt-6.1-sol');
      sol.tariffs.find((tariff: { tier: string }) => tariff.tier === 'default')
        .components.output.price = '12';
      fs.writeFileSync(sourcePath, JSON.stringify(source));
      const tempCompiler = path.join(temp, 'scripts/model-information/compile.cjs');
      execFileSync(process.execPath, [tempCompiler], { cwd: temp });
      const staged = JSON.parse(fs.readFileSync(
        path.join(temp, 'containers/api-proxy/model-information.pricing.generated.json'), 'utf8',
      ));
      expect(staged['gpt-5-codex-mini'].input).toBe('9.0000000000000000000000000001');
      expect(staged['gpt-6.1-sol'].output).toBe('12');
      const active = JSON.parse(fs.readFileSync(
        path.join(temp, 'containers/api-proxy/model-information.fallback-pricing.generated.json'), 'utf8',
      ));
      expect(active.compatibility.providers.openai['gpt-6.1-sol'].output).toBe('10');
      const legacyReference = JSON.parse(fs.readFileSync(
        path.join(temp, 'containers/api-proxy/ai-credits-pricing-reference.json'), 'utf8',
      ));
      expect(legacyReference.providers.openai.models['gpt-6.1-sol'].output).toBe(10);
      expect(active.imported.copilot).toBeUndefined();
      expect(active.imported.openai).toBeUndefined();
      expect(active.compatibility).toMatchObject({
        authority: 'policy', confidence: 'policy_fallback', channel: 'native-api',
        sourceProvenance: require('../../shared/model-information/sources/pricing-reference.json').provenance,
      });
      expect(Object.keys(active.imported.openrouter)).toHaveLength(
        require('../../shared/model-information/imported/legacy-models-dev.snapshot.v1.json').accepted,
      );
      expect(require('../../containers/api-proxy/ai-credits-pricing')['gpt-5-codex-mini'].input).toBe(0.25);
      expect(execFileSync(process.execPath, [tempCompiler, '--check'], { cwd: temp, encoding: 'utf8' }))
        .toContain('Checked');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('uses the latest reviewed timestamp across all provenance sources', () => {
    expect(latestTimestamp([
      { at: '2026-10-19T17:20:11-07:00' },
      { at: '2026-10-21T00:00:00Z' },
    ])).toBe('2026-10-21T00:00:00.000Z');
  });

  it('compiles the four GA Copilot prices and strict Terra threshold', () => {
    const { reviewedCopilotFixture } =
      require('../../containers/api-proxy/test-helpers/copilot-pricing-fixture');
    const fixture = reviewedCopilotFixture();
    expect(fixture.reviewed).toHaveLength(4);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-compile-copilot-prices-'));
    try {
      for (const folder of ['scripts/model-information', 'shared/model-information']) {
        fs.cpSync(path.join(root, folder), path.join(directory, folder), { recursive: true });
      }
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
      const proxy = path.join(directory, 'containers/api-proxy');
      fs.mkdirSync(proxy, { recursive: true });
      fs.copyFileSync(path.join(root, 'containers/api-proxy/models.dev.catalog.json'),
        path.join(proxy, 'models.dev.catalog.json'));
      copyLegacyPricingProjections(directory);
      for (const [file, document] of fixture.plan.updates) {
        fs.writeFileSync(path.join(directory, file), JSON.stringify(document));
      }
      execFileSync(process.execPath, [path.join(directory, 'scripts/model-information/compile.cjs')], {
        cwd: directory,
      });
      const pricing = JSON.parse(fs.readFileSync(
        path.join(proxy, 'model-information.pricing.generated.json'), 'utf8'));
      expect(Object.fromEntries(fixture.ids.map((id: string) => [id, pricing[id]])))
        .toEqual(fixture.projection);
      expect(pricing['gpt-6.1-terra'].longContext.threshold).toBe(272000);
      const { getMaintainedPricingFact } = require('../../containers/api-proxy/catalogue-pricing');
      const originalTerra = getMaintainedPricingFact('copilot', 'gpt-6.1-terra');
      jest.isolateModules(() => {
        jest.doMock('../../containers/api-proxy/model-information.pricing.generated.json', () => pricing);
        const { getMaintainedPricingFact: maintained } = require('../../containers/api-proxy/catalogue-pricing');
        const { selectPricingFact } = require('../../shared/model-information/pricing-resolution');
        const fact = maintained('copilot', 'gpt-6.1-terra');
        expect(selectPricingFact(fact, 272000)).toMatchObject({ tier: 'default', pricing: { input: 1 } });
        expect(selectPricingFact(fact, 272001)).toMatchObject({ tier: 'long_context', pricing: { input: 2 } });
      });
      jest.dontMock('../../containers/api-proxy/model-information.pricing.generated.json');
      expect(getMaintainedPricingFact('copilot', 'gpt-6.1-terra')).toEqual(originalTerra);
      for (const id of ['gemini-3.8-flash', 'gemini-4-argon']) {
        const canonical = fixture.reviewed.find((model: any) => model.identity.rawId === id);
        expect(pricing[id]).toEqual({ tariffs: canonical.tariffs });
        expect(canonical.tariffs).toHaveLength(1);
        expect(canonical.tariffs[0]).not.toHaveProperty('successor');
        expect(canonical.tariffs[0].components.cacheWrite.price).toEqual({ unavailable: true });
      }
    } finally {
      jest.dontMock('../../containers/api-proxy/model-information.pricing.generated.json');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not flatten unsupported maintained tariff scope, units or missing components', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-pricing-scope-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), directory, { recursive: true });
      const file = path.join(directory, 'copilot-main.json');
      const original = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const change of [
        { scope: { provider: 'copilot', channel: 'copilot-cli' } },
        { scope: { provider: 'copilot', channel: 'copilot-api', deployment: 'private' } },
        { unit: 'USD_PER_TOKEN' },
        { currency: 'EUR' },
        { components: {} },
        { components: { ...original.models.find((entry: any) => entry.tariffs?.length)
          .tariffs[0].components, request: {
          price: '1', provenance: original.provenance,
        } } },
        { tier: 'post_promotion' },
        { promotion: 'contract intro without expiry' },
      ]) {
        const source = structuredClone(original);
        const model = source.models.find((entry: { tariffs?: unknown[] }) => entry.tariffs?.length);
        Object.assign(model.tariffs[0], change);
        fs.writeFileSync(file, JSON.stringify(source));
        const result = spawnSync(process.execPath, [compiler, '--check', `--source-dir=${directory}`], {
          cwd: root, encoding: 'utf8',
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/Unsupported maintained fallback tariff|currency|components|effectiveUntil/);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves Copilot promotion intervals and evidenced successor provenance', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-compile-promotion-'));
    try {
      for (const folder of ['scripts/model-information', 'shared/model-information']) {
        fs.cpSync(path.join(root, folder), path.join(directory, folder), { recursive: true });
      }
      fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
      const proxy = path.join(directory, 'containers/api-proxy');
      fs.mkdirSync(proxy, { recursive: true });
      fs.copyFileSync(path.join(root, 'containers/api-proxy/models.dev.catalog.json'),
        path.join(proxy, 'models.dev.catalog.json'));
      copyLegacyPricingProjections(directory);
      // Immutable estimated contract tariffs are not published successor evidence.
      const { copilotPromotionContractFixture } =
        require('../../containers/api-proxy/test-helpers/copilot-pricing-fixture');
      const model = copilotPromotionContractFixture();
      const successor = model.tariffs.find((tariff: any) => tariff.tier === 'post_promotion');
      successor.provenance = structuredClone(require('../../shared/model-information/fixtures.v1.json')
        .model.provenance);
      successor.effectiveUntil = '2027-02-01T00:00:00Z';
      for (const component of Object.values(successor.components) as any[]) {
        component.provenance = successor.provenance;
      }
      successor.components.input.price = '1.5000000000000000000000000001';
      const file = path.join(directory, 'shared/model-information/sources/copilot-gemini.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      const existing = source.models.findIndex((entry: any) => entry.identity.key === model.identity.key);
      if (existing < 0) source.models.push(model);
      else source.models[existing] = model;
      fs.writeFileSync(file, JSON.stringify(source));
      const targetFile = path.join(directory, 'shared/model-information/sources/target.json');
      const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      delete target.tariffs['gemini-3.8-flash'];
      fs.writeFileSync(targetFile, JSON.stringify(target));
      execFileSync(process.execPath, [path.join(directory, 'scripts/model-information/compile.cjs')], {
        cwd: directory,
      });
      const pricing = JSON.parse(fs.readFileSync(
        path.join(proxy, 'model-information.pricing.generated.json'), 'utf8'));
      expect(pricing['gemini-3.8-flash']).toEqual({ tariffs: model.tariffs });
      expect(pricing['gemini-3.8-flash'].input).toBeUndefined();
      expect(pricing['gemini-3.8-flash'].tariffs[1]).toMatchObject({
        effectiveFrom: '2027-01-01T00:00:00Z', effectiveUntil: '2027-02-01T00:00:00Z',
        provenance: successor.provenance,
        components: { input: { price: '1.5000000000000000000000000001',
          provenance: successor.provenance } },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stages named pricing and routing corrections without activating them', () => {
    const baseline = require('../../shared/model-information/catalog.generated.json');
    const target = require('../../shared/model-information/target.generated.json');
    const delta = require('../../shared/model-information/baseline-to-target.generated.json');
    const importedBaseline = baseline.models.find((model: { identity: { key: string } }) =>
      model.identity.key === 'openai/gpt-5.5');
    const lookup = (key: string) => target.models.find((model: { identity: { key: string } }) =>
      model.identity.key === key);
    const activeFlash = baseline.models.find((model: { identity: { key: string } }) =>
      model.identity.key === 'copilot/gemini-3.8-flash');
    const stagedFlash = require('../../shared/model-information/sources/target.json')
      .tariffs['gemini-3.8-flash'];
    if (stagedFlash) {
      expect(activeFlash?.tariffs || []).toHaveLength(0);
      expect(Date.parse(lookup('copilot/gemini-3.8-flash').tariffs[0].effectiveUntil))
        .toBe(Date.parse(stagedFlash.promotionUntil));
    } else {
      expect(activeFlash).toBeDefined();
      expect(lookup('copilot/gemini-3.8-flash').tariffs).toEqual(activeFlash.tariffs);
    }
    expect(lookup('copilot/gemini-3.8-flash').tariffs[0].components.cacheWrite.price)
      .toEqual({ unavailable: true });
    const long = lookup('copilot/grok-4.7').tariffs.find((tier: { tier: string }) =>
      tier.tier === 'long_context');
    expect(long.promptTokensAbove).toBe(200000);
    expect(lookup('openai/gpt-6.1-sol').reasoning.selectableEfforts).not.toContain('none');
    expect(lookup('openai/gpt-5.6-sol').reasoning.selectableEfforts).toContain('none');
    expect(lookup('openai/gpt-5.6-cyber').reasoning.support).toBe('unknown');
    expect(lookup('anthropic/claude-opus-4.6').reasoning).toBeUndefined();
    expect(lookup('anthropic/claude-opus-4.8').reasoning).toBeUndefined();
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
    for (const [provider, family] of [
      ['openai', 'gpt-5.4-mini'], ['anthropic', 'claude-opus-4'], ['anthropic', 'claude-opus-4-6'],
    ]) {
      expect(delta.mapping.target.providers[provider].models.find(
        (entry: { family: string }) => entry.family === family,
      )).toEqual(delta.mapping.baseline.providers[provider].models.find(
        (entry: { family: string }) => entry.family === family,
      ));
    }
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

  it.each([
    { reasoningMode: 'invented' },
    { defaultEffort: 'max' },
    { reasoningMode: 'forbidden', defaultEffort: 'none' },
    { reasoningMode: 'forbidden', defaultEffort: undefined },
    { reasoningMode: 'required', reasoningEfforts: [], defaultEffort: undefined },
    { reasoningEfforts: ['none', 42] },
    { reasoningEfforts: ['none', ''] },
  ])('rejects invalid reviewed routing mode/default %j before generation', fields => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-routing-'));
    try {
      fs.cpSync(path.join(root, 'shared/model-information/sources'), temp, { recursive: true });
      const file = path.join(temp, 'mapping.json');
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      const mini = source.mapping.providers.openai.models.find(
        (entry: { family: string }) => entry.family === 'gpt-5.4-mini',
      );
      Object.assign(mini.routing, fields);
      fs.writeFileSync(file, JSON.stringify(source));
      expect(() => run('--check', `--source-dir=${temp}`)).toThrow(/mapping.json: openai.*invalid mapping entry/);
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
    expect(dockerfile).toMatch(/model-information\.pricing\.generated\.json model-information\.fallback-pricing\.generated\.json model-information\.retired\.generated\.json/);
    expect(dockerfile).toMatch(/model-eligibility\.js/);
    expect(dockerfile).toMatch(/model-reasoning\.js/);
    expect(dockerfile).toMatch(/harness-observation\.js/);
    expect(dockerfile).toMatch(/model-decision-diagnostics\.js model-decision-diagnostics\.schema\.json model-decision-observation\.js/);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-assets-'));
    try {
      const fixturePath = fs.realpathSync(temp);
      const checkoutPath = fs.realpathSync(root);
      expect(fixturePath).not.toBe(checkoutPath);
      expect(fixturePath.startsWith(checkoutPath + path.sep)).toBe(false);
      fs.mkdirSync(path.join(temp, 'guards'));
      for (const file of ['model-information.pricing.generated.json',
        'model-information.retired.generated.json', 'model-api-mapping.json', 'model-api-mapping.js',
        'model-information.naming.generated.json', 'model-identity.js', 'model-utils.js',
        'model-eligibility.js', 'harness-observation.js', 'model-information.eligibility.generated.json',
        'provider-pricing-overlays.js',
        'guards/retired-model-guard.js', 'guards/model-policy-guard.js', 'guards/guard-utils.js',
        'logging.js', 'trusted-service.js', 'body-utils.js']) {
        fs.copyFileSync(path.join(root, 'containers/api-proxy', file), path.join(temp, file));
      }
      fs.cpSync(path.join(root, 'containers/api-proxy/catalogue-contract'),
        path.join(temp, 'catalogue-contract'), { recursive: true });
      const output = execFileSync(process.execPath, ['-e',
        `
        const assert = require('node:assert/strict');
        const mapping = require('./model-api-mapping');
        assert(mapping.lookupModelEndpoints('gpt-5.5', 'openai'));
        const guard = require('./guards/retired-model-guard');
        assert.equal(guard.getRetiredModelBlockState('GPT-5-CODEX').suggestion, 'gpt-5.3-codex');
        assert.equal(guard.getRetiredModelBlockState('GPT_5_CODEX'), null);
        const { createProxyEligibilityStore, evaluateModelEligibility } = require('./model-eligibility');
        const { resolveModelIdentity } = require('./model-identity');
        const scope = { provider: 'copilot', channel: 'copilot-api' };
        const identity = resolveModelIdentity('gpt-5.3-codex', 'copilot', { scope }).identity;
        const requirement = {
          scope, name: 'copilot', scheme: 'semver', minimum: '2.0.0',
          reason: 'Reviewed packaged harness fixture',
          provenance: { authority: 'maintained', source: 'packaging-fixture' },
        };
        const models = [{ identity, harnesses: [requirement] }];
        const store = createProxyEligibilityStore({ models, executionEnvironment: 'container:packaged' });
        const pinnedRequest = { awfEligibility: store.pin() };
        const missing = evaluateModelEligibility('gpt-5.3-codex', 'copilot', pinnedRequest);
        assert.equal(missing.admitted, false);
        assert.equal(missing.harness, 'unverified');
        store.replaceTrustedEvidence({
          models, executionEnvironment: 'container:packaged',
          observations: [{
            scope, name: 'copilot', version: '2.0.0', environment: 'container:packaged',
            verified: true, actual: true,
          }],
        });
        assert.equal(evaluateModelEligibility('gpt-5.3-codex', 'copilot', pinnedRequest).admitted, false);
        const compatible = evaluateModelEligibility('gpt-5.3-codex', 'copilot', { awfEligibility: store.pin() });
        assert.equal(compatible.admitted, true);
        assert.equal(compatible.harness, 'compatible');
        assert.equal(compatible.identity.key, 'copilot/gpt-5.3-codex');
        `],
      { cwd: temp, encoding: 'utf8' });
      expect(output).toBe('');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('loads the compiled and bundled host lifecycle reader outside the source tree', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-host-lifecycle-'));
    try {
      const fixturePath = fs.realpathSync(temp);
      const checkoutPath = fs.realpathSync(root);
      expect(fixturePath).not.toBe(checkoutPath);
      expect(fixturePath.startsWith(checkoutPath + path.sep)).toBe(false);
      const compiled = path.join(temp, 'compiled');
      execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
        '--target', 'es2020', '--module', 'commonjs', '--resolveJsonModule',
        '--esModuleInterop', '--skipLibCheck', '--allowJs', '--outDir', compiled,
        path.join(root, 'src/copilot-model.ts'),
        path.join(root, 'src/model-information-contract/identity.js'),
        path.join(root, 'src/model-information-contract/resolution.js'),
        path.join(root, 'src/model-information-contract/eligibility.js')], { cwd: root, encoding: 'utf8' });
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
