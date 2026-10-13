'use strict';

const { resolveModelSelector: resolveSelector } = require('./model-selector');
const { parseProviderModelMetadata } = require('./runtime-model-catalog');

const ids = ['gpt-5.6-terra', 'claude-sonnet-5'];
const records = parseProviderModelMetadata('copilot', {
  data: [
    { id: ids[0], name: 'GPT-5.6 Terra' },
    { id: ids[1], name: 'Claude Sonnet 5' },
  ],
});

function resolveModelSelector(...args) {
  return resolveSelector(...args)?.resolvedModel ?? null;
}

describe('selected scalar model selectors', () => {
  it.each([
    'GPT-5.6 Terra', 'GPT-5.6 Terra (copilot)', 'gpt-5.6-terra',
    'GPT-5.6 TERRA (Copilot)', 'copilot/gpt-5.6-terra',
    'gpt-5.6-terra (copilot)',
  ])('resolves %s using the active catalog', selector => {
    expect(resolveModelSelector(selector, 'copilot', ids, records)).toBe(ids[0]);
  });

  it('retains provider display-name metadata without inventing it from IDs', () => {
    const metadata = parseProviderModelMetadata('openai', { data: [
      { id: 'deployment-a', display_name: 'Model A' },
      { id: 'deployment-b', displayName: 'Model B' },
      { id: 'deployment-c' },
    ] });
    expect(metadata[0].displayName).toBe('Model A');
    expect(metadata[1].displayName).toBe('Model B');
    expect(metadata[2]).not.toHaveProperty('displayName');
  });

  it('does not select across vendors', () => {
    try {
      resolveModelSelector('GPT-5.6 Terra (openai)', 'copilot', ids, records);
      throw new Error('expected provider mismatch');
    } catch (error) {
      expect(error.message).toContain('does not match the active provider');
      expect(error.catalogRefreshable).toBe(false);
    }
  });

  it('matches a complete advertised display name before parsing parentheses as a vendor', () => {
    expect(resolveModelSelector('Model (Preview)', 'copilot', ids, [
      { id: ids[0], displayName: 'Model (Preview)' },
    ])).toBe(ids[0]);
  });

  it('rejects colliding display names instead of guessing', () => {
    const ambiguous = records.map(record => ({ ...record, displayName: 'Shared Name' }));
    for (const selector of ['Shared Name', 'Shared Name (copilot)']) {
      expect(() => resolveModelSelector(selector, 'copilot', ids, ambiguous)).toThrow('ambiguous');
    }
    expect(resolveModelSelector(ids[0], 'copilot', ids, ambiguous)).toBe(ids[0]);
  });

  it.each([ids, null])('rejects unknown UI selectors with catalog %j', catalog => {
    expect(() => resolveModelSelector('Unknown Model (copilot)', 'copilot', catalog, records))
      .toThrow('Use a canonical provider model ID');
    expect(() => resolveModelSelector('GPT 5.6 Terra', 'copilot', catalog, []))
      .toThrow('Unsupported');
  });

  it('leaves list order and availability selection to the custom-agent surface', () => {
    const prioritized = ['Missing Model (copilot)', 'GPT-5.6 Terra (copilot)', 'Claude Sonnet 5 (copilot)'];
    expect(() => resolveModelSelector(prioritized, 'copilot', ids, records))
      .toThrow('first available entry');
    expect(prioritized).toEqual(['Missing Model (copilot)', 'GPT-5.6 Terra (copilot)', 'Claude Sonnet 5 (copilot)']);
  });

  it('uses an explicit alias ahead of an advertised display name', () => {
    expect(resolveModelSelector('GPT-5.6 Terra', 'copilot', ids, records, {
      'GPT-5.6 Terra': ['copilot/claude-sonnet-5'],
    })).toBe(ids[1]);
    expect(resolveModelSelector('sonnet (copilot)', 'copilot', ids, records, {
      sonnet: ['copilot/claude-sonnet-5'],
    })).toBe(ids[1]);
  });

  it('retains policy-aware alias candidates and model parameters for endpoint retries', () => {
    const aliases = { 'Team Model': ['copilot/*'] };
    const selection = resolveSelector(
      'Team Model (copilot)?reasoning=high', 'copilot', ids, records, aliases,
    );
    expect(selection.candidates).toEqual(expect.arrayContaining(ids.map(id => `${id}?reasoning=high`)));
    expect(selection.log.length).toBeGreaterThan(0);
    const permitted = resolveSelector('Team Model', 'copilot', ids, records, aliases, {
      allowedModels: ['claude-sonnet-5'],
    });
    expect(permitted.resolvedModel).toBe('claude-sonnet-5');
    expect(permitted.candidates).toEqual(['claude-sonnet-5']);
  });

  it('never applies middle-power fallback to an unresolved display-name alias', () => {
    expect(() => resolveModelSelector('Unknown Model', 'copilot', ids, records, {
      'Unknown Model': ['copilot/nonexistent'],
    })).toThrow('no available catalog model');
  });

  it.each(['Team Deployment v2', 'GPT-5.6 Terra (private)', 'my/arbitrary_deployment', 'GPT-5.6 Terra'])(
    'preserves exact deployment ID %s ahead of selector interpretation', id => {
      expect(resolveModelSelector(id, 'copilot', [...ids, id], records, {
        [id]: ['copilot/claude-sonnet-5'],
      })).toBe(id);
    },
  );

  it('preserves ordinary BYOK IDs and model parameters', () => {
    expect(resolveModelSelector('my_deployment-v2', 'openai', null, [])).toBeNull();
    expect(resolveModelSelector('GPT-5.6 Terra (copilot)?reasoning=high', 'copilot', ids, records))
      .toBe('gpt-5.6-terra?reasoning=high');
  });
});
