import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  importLegacySnapshot, importPinnedLegacySnapshot, BUNDLED_GIT_BLOB, BUNDLED_SHA256,
  BUNDLED_COMMIT_TIMESTAMP,
} from '../../shared/model-information/import-legacy-snapshot';
import { validate } from '../../shared/model-information/contracts';

const metadata = (bytes: Buffer) => ({
  source: 'committed legacy catalog fixture (OpenRouter-shaped)',
  revision: 'fixture-revision',
  retrievedAt: '2026-10-20T00:00:00Z',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  license: 'upstream license unknown; test fixture only',
});
const importEntries = (entries: unknown[]) => {
  const bytes = Buffer.from(JSON.stringify({ data: entries }));
  return importLegacySnapshot(bytes, metadata(bytes));
};
const priced = (id: string, pricing: Record<string, unknown> = {
  prompt: '0.000000123456789',
  completion: '0',
}) => ({ id, pricing });

describe('governed legacy catalog import', () => {
  it('uses exact provider-qualified IDs, exact decimal units and field provenance', () => {
    const snapshot = importEntries([
      priced('openai/GPT_5.5-pro', {
        prompt: '0.000000123456789', completion: '0', input_cache_read: '0.00000001',
        web_search: '0.01',
      }),
      priced('other/GPT_5.5-pro'),
    ]);
    expect(validate('importedSnapshot', snapshot)).toEqual([]);
    expect(snapshot).toMatchObject({ accepted: 2, rejected: 0, collisions: [] });
    const model: any = snapshot.models.find((item: any) => item.identity.provider === 'openai');
    expect(model.identity).toEqual({
      key: 'openai/GPT_5.5-pro', provider: 'openai',
      rawId: 'GPT_5.5-pro', lookupId: 'gpt-5-5-pro',
    });
    expect(model.importedPricing).toMatchObject({
      sourceNamespace: 'openai',
      currency: 'USD',
      unit: 'USD_PER_1M_TOKENS',
      components: {
        input: { price: '0.123456789', provenance: expect.objectContaining({ authority: 'imported', revision: 'fixture-revision' }) },
        output: { price: '0', provenance: expect.any(Object) },
        cachedInput: { price: '0.01', provenance: expect.any(Object) },
      },
    });
    expect(model).not.toHaveProperty('tariffs');
    expect(model).not.toHaveProperty('availability');
    expect(model).not.toHaveProperty('protocols');
    expect(model).not.toHaveProperty('reasoning');
    expect(model).not.toHaveProperty('identity.aliases');
  });

  it('rejects ambiguous normalized identities rather than choosing a price by file order', () => {
    const snapshot = importEntries([
      priced('openai/GPT_5.5'), priced('openai/gpt-5-5'),
      priced('other/GPT_5.5'), priced('openai/safe', { prompt: '-1', completion: '1' }),
    ]);
    expect(snapshot).toMatchObject({ accepted: 1, rejected: 3 });
    expect(snapshot.collisions).toEqual(['openai/gpt-5-5: openai/GPT_5.5, openai/gpt-5-5']);
    expect(snapshot.models[0]).toMatchObject({ identity: { key: 'other/GPT_5.5' } });
  });

  it('fails closed on invalid provenance, integrity, source shape and timestamps', () => {
    const bytes = Buffer.from(JSON.stringify({ data: [priced('openai/model')] }));
    const pinned = metadata(bytes);
    expect(() => importLegacySnapshot(bytes, { ...pinned, sha256: '0'.repeat(64) })).toThrow('SHA-256');
    expect(() => importLegacySnapshot(bytes, { ...pinned, retrievedAt: '2026-02-31T00:00:00Z' })).toThrow('metadata');
    expect(() => importLegacySnapshot(bytes, { ...pinned, retrievedAt: '' })).toThrow('metadata');
    expect(() => importLegacySnapshot(bytes, { ...pinned, revision: '' })).toThrow('metadata');
    expect(() => importLegacySnapshot(bytes, { ...pinned, extra: 'untrusted' } as any)).toThrow('metadata');
    const malformed = Buffer.from(JSON.stringify({ models: [] }));
    expect(() => importLegacySnapshot(malformed, metadata(malformed))).toThrow('{data: []}');
  });

  it('accepts the official complete API envelope and rejects partial/paginated coverage', () => {
    const complete = Buffer.from(JSON.stringify({
      data: [priced('openai/fixture')], total_count: 1, links: { next: null },
    }));
    expect(importLegacySnapshot(complete, metadata(complete))).toMatchObject({ accepted: 1, rejected: 0 });
    for (const envelope of [
      { data: [priced('openai/fixture')], total_count: 2, links: { next: null } },
      { data: [priced('openai/fixture')], total_count: 1, links: { next: '/next' } },
      { data: [priced('openai/fixture')], links: {} },
      { data: [priced('openai/fixture')], total_count: -1 },
    ]) {
      const bytes = Buffer.from(JSON.stringify(envelope));
      expect(() => importLegacySnapshot(bytes, metadata(bytes))).toThrow('Incomplete catalogue coverage');
    }
  });

  it('imports the reviewed pin with exact bytes/counts and the committed capture metadata', () => {
    const bytes = readFileSync('containers/api-proxy/models.dev.catalog.json');
    const snapshot = importPinnedLegacySnapshot();
    const pinned = JSON.parse(readFileSync('shared/model-information/imported/legacy-models-dev.metadata.json', 'utf8'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(BUNDLED_SHA256);
    expect(snapshot.revision).toBe(BUNDLED_GIT_BLOB);
    expect(snapshot.accepted).toBeGreaterThan(0);
    expect(snapshot.accepted + snapshot.rejected).toBe(JSON.parse(bytes.toString()).data.length);
    expect(snapshot.collisions).toEqual([]);
    expect(snapshot.retrievedAt).toBe(BUNDLED_COMMIT_TIMESTAMP);
    expect(snapshot).toMatchObject(pinned);
    if (snapshot.source.startsWith('git-committed')) expect(snapshot.source).toContain('NOT upstream retrieval');
    expect(validate('importedSnapshot', snapshot)).toEqual([]);
    expect(snapshot.models.every((model: any) => model.importedPricing.sourceNamespace === model.identity.provider)).toBe(true);
    expect(snapshot.models.every((model: any) => !model.tariffs)).toBe(true);
    const committed = JSON.parse(readFileSync('shared/model-information/imported/legacy-models-dev.snapshot.v1.json', 'utf8'));
    expect(committed).toEqual(snapshot);
  });
});
