import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { getPricingSnapshot, readPricingSnapshot, PricingSnapshot } from '../../shared/model-information/pricing-consumer';

const { json, digest } = require('../../shared/model-information/publication-contract.cjs');
const { resolveCentralTariff } = require('../../shared/model-information/pricing-resolution');
const root = path.resolve(__dirname, '../..');
const filename = 'shared/model-information/pricing-consumer.v1.generated.json';
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const fixture = (): Mutable<PricingSnapshot> => JSON.parse(JSON.stringify(getPricingSnapshot()));
const seal = (snapshot: Mutable<PricingSnapshot>) => {
  const { revision, ...payload } = snapshot;
  return json({ ...payload, revision: digest(json(payload)) });
};

describe('offline pricing consumer v1', () => {
  it('projects existing authorities losslessly, without staged facts or runtime observations', () => {
    const snapshot = getPricingSnapshot();
    const catalogue = require('../../shared/model-information/catalog.generated.json');
    const fallback = require('../../containers/api-proxy/model-information.fallback-pricing.generated.json');
    expect(snapshot.catalogRevision).toBe(catalogue.catalogRevision);
    expect(snapshot.generatedAt).toBe(catalogue.generatedAt);
    expect(snapshot.maintained).toEqual(catalogue.models
      .filter((model: { provenance: { authority: string }; tariffs?: unknown[] }) =>
        model.provenance.authority === 'maintained' && model.tariffs?.length)
      .map((model: { identity: Record<string, string>; tariffs: unknown[]; provenance: unknown }) => ({
        identity: Object.fromEntries(['key', 'provider', 'rawId', 'lookupId']
          .map(key => [key, model.identity[key]])),
        tariffs: model.tariffs, provenance: model.provenance,
      })));
    expect(snapshot.compatibility).toEqual(fallback.compatibility);
    expect(snapshot.imported).toEqual([{
      scope: { provider: 'openrouter', channel: 'native-api' },
      prices: fallback.imported.openrouter,
    }]);
    for (const id of ['gpt-5.6-sol-fast', 'gpt-6.1-sol-fast', 'mai-code-2-flash']) {
      expect(snapshot.maintained.some(model => model.identity.rawId === id)).toBe(false);
    }
    expect(snapshot.maintained.length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.imported[0].prices).length).toBeGreaterThan(0);
  });

  it('retains decimal text, absent, unavailable and zero components, and exact scoped identities', () => {
    const snapshot = fixture();
    const model = snapshot.maintained[0];
    const tariff = model.tariffs[0];
    tariff.components.input!.price = '0.123456789012345678901234567890';
    tariff.components.output!.price = '0';
    tariff.components.cacheWrite!.price = { unavailable: true };
    delete tariff.components.cachedInput;
    tariff.scope = { provider: model.identity.provider, channel: 'byok', deployment: 'fixture' };
    const result = readPricingSnapshot(seal(snapshot));
    expect(result.maintained[0]).toEqual(model);
    expect(result.maintained[0].tariffs[0].components).not.toHaveProperty('cachedInput');
    expect(result.maintained[0].tariffs[0].scope).toEqual(tariff.scope);
    expect(result.imported[0].scope.provider).toBe('openrouter');
    expect(result.imported[0].prices['anthropic/claude-sonnet-5.5']!.sourceNamespace).toBe('anthropic');
    expect(result.compatibility.authority).toBe('policy');
    expect(result.compatibility.confidence).toBe('policy_fallback');
    expect(result.compatibility.providers.openai!['gpt-6.1-sol']!.input).toBe('2');
  });

  it.each([
    ['gpt-6.1-sol', 272000, 2, 4],
    ['claude-haiku-5.5', 100000, 0.1, 0.5],
  ] as const)('preserves strict %s context thresholds and exact scope applicability', (id, threshold, base, long) => {
    const snapshot = getPricingSnapshot();
    const record = snapshot.maintained.find(model => model.identity.rawId === id)!;
    const fact = { record, source: 'offline-fixture', revision: snapshot.revision };
    const resolve = (tokens: number, scope = { provider: 'copilot', channel: 'copilot-api' }) =>
      resolveCentralTariff({
        scope, inputTokens: tokens, time: Date.parse('2026-10-23T00:00:00Z'),
        maxAge: 30 * 24 * 3600 * 1000,
      }, fact);
    expect(resolve(threshold).result.pricing.input).toBe(base);
    expect(resolve(threshold + 1).result.pricing.input).toBe(long);
    for (const scope of [
      { provider: 'openai', channel: 'native-api' },
      { provider: 'copilot', channel: 'byok' },
      { provider: 'copilot', channel: 'copilot-api', deployment: 'custom' },
    ]) expect(resolve(threshold + 1, scope)).toBeNull();
    expect(snapshot.maintained.some(model => model.identity.provider === 'custom')).toBe(false);
  });

  it('preserves promotion expiry and successors without making staged target prices active', () => {
    const snapshot = fixture();
    const model = snapshot.maintained[0];
    const tariff = model.tariffs[0];
    tariff.effectiveFrom = '2026-10-21T00:00:00Z';
    tariff.effectiveUntil = '2026-10-23T00:00:00Z';
    tariff.promotion = 'fixture-only';
    tariff.successor = 'post-promotion-fixture';
    model.tariffs = [tariff];
    const parsed = readPricingSnapshot(seal(snapshot));
    const fact = { record: parsed.maintained[0], source: 'offline-fixture', revision: parsed.revision };
    const resolve = (time: string) => resolveCentralTariff({
      scope: tariff.scope, inputTokens: 0, time: Date.parse(time), maxAge: 30 * 24 * 3600 * 1000,
    }, fact);
    expect(parsed.maintained[0].tariffs).toEqual([tariff]);
    expect(resolve('2026-10-20T23:59:59Z')).toBeNull();
    expect(resolve('2026-10-21T00:00:00Z')).not.toBeNull();
    expect(resolve('2026-10-22T23:59:59Z')).not.toBeNull();
    expect(resolve('2026-10-23T00:00:00Z')).toBeNull();
  });

  it('rejects unknown schemas, changed content, malformed decimals, scopes, dates and authority', () => {
    const snapshot = fixture();
    expect(() => readPricingSnapshot(JSON.stringify({ ...snapshot, schemaVersion: 2 }))).toThrow(/schema/);
    expect(() => readPricingSnapshot(JSON.stringify({ ...snapshot, schemaHash: '0'.repeat(64) }))).toThrow(/schema/);
    expect(() => readPricingSnapshot(JSON.stringify({ ...snapshot, extra: true }))).toThrow(/schema/);
    snapshot.maintained[0].tariffs[0].components.input!.price = '999';
    expect(() => readPricingSnapshot(JSON.stringify(snapshot))).toThrow(/revision/);
    for (const price of ['-1', 'NaN', '1e-8', '0.' + '1'.repeat(401)]) {
      const invalid = fixture();
      invalid.maintained[0].tariffs[0].components.input!.price = price;
      expect(() => readPricingSnapshot(seal(invalid))).toThrow();
    }
    const crossProvider = fixture();
    crossProvider.maintained[0].tariffs[0].scope.provider = 'openai';
    expect(() => readPricingSnapshot(seal(crossProvider))).toThrow(/Cross-provider/);
    const badDate = fixture();
    badDate.maintained[0].tariffs[0].effectiveFrom = '2026-02-30T00:00:00Z';
    expect(() => readPricingSnapshot(seal(badDate))).toThrow(/schema/);
    const badInterval = fixture();
    badInterval.maintained[0].tariffs[0].effectiveFrom = '2026-11-01T00:00:00Z';
    badInterval.maintained[0].tariffs[0].effectiveUntil = '2026-10-01T00:00:00Z';
    expect(() => readPricingSnapshot(seal(badInterval))).toThrow(/interval/);
    const badAuthority = fixture();
    badAuthority.maintained[0].provenance.authority = 'operator';
    expect(() => readPricingSnapshot(seal(badAuthority))).toThrow(/provenance/);
    const badNamespace = fixture();
    badNamespace.imported[0].prices['anthropic/claude-sonnet-5.5']!.sourceNamespace = 'openai';
    expect(() => readPricingSnapshot(seal(badNamespace))).toThrow(/import_scope/);
    expect(() => readPricingSnapshot('not JSON')).toThrow();
  });

  it('returns deeply frozen independent snapshots and caches only the bundled view', () => {
    const snapshot = getPricingSnapshot();
    expect(getPricingSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot.maintained[0].tariffs[0].components.input)).toBe(true);
    expect(Object.isFrozen(snapshot.imported[0].prices)).toBe(true);
    expect(Object.isFrozen(snapshot.compatibility.providers.openai)).toBe(true);
    expect(() => Object.assign(snapshot.maintained[0].tariffs[0].components.input!, { price: '99' })).toThrow();
    expect(readPricingSnapshot(JSON.stringify(snapshot))).not.toBe(snapshot);
    const jsonData = require('../../shared/model-information/pricing-consumer.v1.generated.json');
    expect(Object.isFrozen(jsonData)).toBe(false);
    expect(snapshot).toEqual(jsonData);
  });

  it('is deterministic, source-owned and checked for staleness by the ordinary compiler', () => {
    const { projections, allowed } = require('./maintain.cjs');
    expect(projections).toContain(filename);
    expect(allowed(filename)).toBe(true);
    expect(allowed('shared/model-information/pricing-consumer.js')).toBe(false);
    const before = fs.readFileSync(path.join(root, filename), 'utf8');
    execFileSync(process.execPath, ['scripts/model-information/compile.cjs', '--check'], { cwd: root });
    expect(fs.readFileSync(path.join(root, filename), 'utf8')).toBe(before);
    expect(seal(fixture())).toBe(before);
    const reversed = Object.fromEntries(Object.entries(fixture()).reverse());
    expect(readPricingSnapshot(JSON.stringify(reversed)).revision).toBe(getPricingSnapshot().revision);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-pricing-stale-'));
    try {
      for (const folder of ['shared/model-information', 'containers/api-proxy']) {
        fs.cpSync(path.join(root, folder), path.join(directory, folder), { recursive: true });
      }
      const stale = JSON.parse(before);
      stale.compatibility.providers.openai['gpt-6.1-sol'].input = '999';
      fs.writeFileSync(path.join(directory, filename), JSON.stringify(stale));
      const check = spawnSync(process.execPath, [
        'scripts/model-information/compile.cjs', '--check', `--root=${directory}`,
      ], { cwd: root, encoding: 'utf8' });
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain(`${filename}: stale`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ships JSON, schemas, types and a working immutable API in the actual off-tree npm package', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-pricing-consumer-package-'));
    try {
      const packed = JSON.parse(execFileSync('npm', [
        'pack', '--json', '--ignore-scripts', '--pack-destination', directory,
      ], { cwd: root, encoding: 'utf8' }))[0];
      for (const file of [
        filename, 'shared/model-information/pricing-consumer.js',
        'shared/model-information/pricing-consumer.d.ts',
        'shared/model-information/pricing-consumer.v1.schema.json',
        'shared/model-information/schema.v1.json',
      ]) expect(packed.files.some((entry: { path: string }) => entry.path === file)).toBe(true);
      execFileSync('tar', ['-xzf', path.join(directory, packed.filename), '-C', directory]);
      const packageDirectory = path.join(directory, 'package');
      fs.mkdirSync(path.join(directory, 'node_modules'));
      fs.mkdirSync(path.join(directory, 'node_modules/@github'));
      fs.symlinkSync(packageDirectory,
        path.join(directory, 'node_modules/@github/agentic-workflow-firewall'), 'dir');
      for (const dependency of ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']) {
        fs.cpSync(path.join(root, 'node_modules', dependency),
          path.join(directory, 'node_modules', dependency), { recursive: true });
      }
      fs.writeFileSync(path.join(directory, 'consumer.ts'), `
        import { getPricingSnapshot, readPricingSnapshot, PricingSnapshot } from '@github/agentic-workflow-firewall/shared/model-information/pricing-consumer';
        const view: PricingSnapshot = readPricingSnapshot(JSON.stringify(getPricingSnapshot()));
        const price: string | { readonly unavailable: true } | undefined =
          view.maintained[0].tariffs[0].components.input?.price;
        // @ts-expect-error The public contract is deeply readonly.
        view.maintained[0].tariffs[0].components.input!.price = '0';
        // @ts-expect-error Arrays are readonly too.
        view.maintained.push(view.maintained[0]);
        // @ts-expect-error Uncovered providers require an absence check.
        view.compatibility.providers.uncovered['uncovered'].input;
        void price;
      `);
      fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [], target: 'ES2020', module: 'commonjs' },
        files: ['consumer.ts'],
      }));
      execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc')], {
        cwd: directory, encoding: 'utf8',
      });
      const result = execFileSync(process.execPath, ['-e', `
        'use strict';
        const assert = require('node:assert/strict');
        const deny = () => { throw new Error('network forbidden'); };
        for (const name of ['http', 'https']) {
          require('node:' + name).request = deny;
          require('node:' + name).get = deny;
        }
        require('node:net').Socket.prototype.connect = deny;
        require('node:tls').connect = deny;
        global.fetch = deny;
        const denyWrite = () => { throw new Error('writes forbidden'); };
        for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync']) {
          require('node:fs')[name] = denyWrite;
        }
        const api = require('@github/agentic-workflow-firewall/shared/model-information/pricing-consumer');
        const data = require('@github/agentic-workflow-firewall/shared/model-information/pricing-consumer.v1.generated.json');
        const view = api.getPricingSnapshot();
        assert.deepEqual(view, data);
        assert.equal(view.maintained.find(m => m.identity.rawId === 'gpt-6.1-sol')
          .tariffs.find(t => t.tier === 'long_context').promptTokensAbove, 272000);
        assert.throws(() => { view.maintained[0].tariffs[0].components.input.price = '0'; });
        assert.deepEqual(api.readPricingSnapshot(JSON.stringify(data)), view);
        const { json, digest, pricingPayload, pricingSnapshotPath } =
          require('@github/agentic-workflow-firewall/shared/model-information/publication-contract.cjs');
        const newer = JSON.parse(JSON.stringify(data));
        newer.maintained[0].tariffs[0].components.input.price = '1.0000000000000000000000000001';
        newer.revision = digest(json(pricingPayload(newer)));
        const nextBytes = json(newer);
        assert.notEqual(api.readPricingSnapshot(nextBytes).revision, view.revision);
        const pointer = json({ schemaVersion: 1, revision: newer.revision,
          sourceCommit: 'a'.repeat(40), snapshot: pricingSnapshotPath(newer.revision),
          sha256: digest(nextBytes) });
        assert.equal(api.readPublishedPricingSnapshot(nextBytes, pointer, nextBytes)
          .snapshot.revision, newer.revision);
        assert.equal(api.getPricingSnapshot().revision, view.revision);
        assert.throws(() => api.readPricingSnapshot(JSON.stringify({ ...newer, schemaVersion: 2 })));
        console.log(view.revision);
      `], { cwd: directory, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
      expect(result.trim()).toBe(getPricingSnapshot().revision);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);
});
