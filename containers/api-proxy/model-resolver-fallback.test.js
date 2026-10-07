/**
 * Tests for selectMiddlePowerFallback() and rewriteModelInBody() in
 * model-resolver.js / model-body-rewriter.js.
 *
 * Consolidates the selectMiddlePowerFallback coverage that was previously
 * split between two non-adjacent describe blocks in model-resolver.test.js:
 *   - basic fallback selection
 *   - price filtering
 *
 * Tests for parseModelAliases, filterResolvableAliases,
 * filterAvailableModelsToConfiguredProviders, and cross-provider alias
 * fan-out live in model-resolver.test.js. resolveModel coverage lives in
 * model-resolver-resolution.test.js.
 */

const { selectMiddlePowerFallback } = require('./model-resolver');
const { rewriteModelInBody } = require('./model-body-rewriter');

describe('selectMiddlePowerFallback', () => {
  it('sorts Anthropic tiers as opus > sonnet > haiku and picks median', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { anthropic: ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5'] },
      'anthropic',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result.fallback.candidates.map(c => c.model)).toEqual([
      'claude-opus-4-1',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]);
    expect(result.resolvedModel).toBe('claude-sonnet-4-5');
  });

  it('sorts OpenAI/Copilot tiers as gpt-5 > gpt-4 > gpt-3.5 and picks median', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { openai: ['gpt-3.5-turbo', 'gpt-5.2', 'gpt-4.1'] },
      'openai',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result.fallback.candidates.map(c => c.model)).toEqual([
      'gpt-5.2',
      'gpt-4.1',
      'gpt-3.5-turbo',
    ]);
    expect(result.resolvedModel).toBe('gpt-4.1');
  });

  it('uses lexicographic sorting for unknown providers and picks median', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { gemini: ['z-model', 'a-model', 'm-model'] },
      'gemini',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result.fallback.candidates.map(c => c.model)).toEqual(['a-model', 'm-model', 'z-model']);
    expect(result.resolvedModel).toBe('m-model');
  });

  it('returns null when no models are available for provider', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { copilot: [] },
      'copilot',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result).toBeNull();
  });
});

// ── rewriteModelInBody ─────────────────────────────────────────────────────

describe('rewriteModelInBody', () => {
  const availableModels = {
    copilot: ['claude-sonnet-4.5', 'claude-sonnet-4.6', 'gpt-4o'],
  };

  const aliases = {
    sonnet: ['copilot/*sonnet*'],
  };

  it('should rewrite an aliased model in the request body', () => {
    const body = Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
    expect(result.originalModel).toBe('sonnet');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('claude-sonnet-4.6');
  });

  it('should rewrite model aliases while preserving URL-style parameters for the provider', () => {
    const body = Buffer.from(JSON.stringify({ model: 'sonnet?effort=high', messages: [] }));
    const result = rewriteModelInBody(
      body,
      'copilot',
      aliases,
      { copilot: ['claude-sonnet-5', ...availableModels.copilot] }
    );

    expect(result).not.toBeNull();
    expect(result.originalModel).toBe('sonnet?effort=high');
    expect(result.resolvedModel).toBe('claude-sonnet-5?effort=high');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('claude-sonnet-5?effort=high');
  });

  it('should return null for a model with no alias', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [] }));
    // gpt-4o is a direct match, but the resolved model equals the original so we return null
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull(); // No rewrite needed
  });

  it('should not rewrite the Copilot auto model', () => {
    const body = Buffer.from(JSON.stringify({ model: 'auto', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull();
  });

  it('should return null for non-JSON body', () => {
    const body = Buffer.from('not json');
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull();
  });

  it('should return null for an empty body', () => {
    const result = rewriteModelInBody(Buffer.alloc(0), 'copilot', aliases, availableModels);
    expect(result).toBeNull();
  });

  it('should rewrite to middle-power fallback when alias cannot be resolved', () => {
    const body = Buffer.from(JSON.stringify({ model: 'unknown-alias', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    expect(result.fallback.activated).toBe(true);
  });

  it('should rewrite to highest available gpt-5 model when requested minor is unavailable', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [] }));
    const result = rewriteModelInBody(
      body,
      'copilot',
      aliases,
      { copilot: ['gpt-5.2', 'gpt-5.4', 'gpt-4.1'] }
    );
    expect(result).not.toBeNull();
    expect(result.originalModel).toBe('gpt-5.5');
    expect(result.resolvedModel).toBe('gpt-5.4');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('gpt-5.4');
  });

  it('should try the default alias when model field is absent', () => {
    const defaultAliases = {
      '': ['copilot/*sonnet*'],
    };
    const body = Buffer.from(JSON.stringify({ messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', defaultAliases, availableModels);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
    expect(result.originalModel).toBe('');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('claude-sonnet-4.6');
  });

  it('should include a resolution log', () => {
    const body = Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    expect(Array.isArray(result.log)).toBe(true);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it('should preserve other fields in the request body', () => {
    const original = { model: 'sonnet', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
    const body = Buffer.from(JSON.stringify(original));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.messages).toEqual(original.messages);
    expect(parsed.temperature).toBe(0.7);
  });
});

// ── Middle-power price filtering ───────────────────────────────────────────

describe('selectMiddlePowerFallback price filtering', () => {
  const catalog = [
    'crest-alpha-0416-block-a',
    'crest-alpha-0418-block-b',
    'crest-alpha-0420-block-c',
    'crest-alpha-0422-block-d',
    'gpt-4-turbo',
  ];
  const isPriceable = m => !m.startsWith('crest-alpha');

  it('excludes unpriceable models from the fallback pool', () => {
    const result = selectMiddlePowerFallback(
      'something', { openai: catalog }, 'openai', 'test',
      { enabled: true, strategy: 'middle_power', isModelPriceable: isPriceable }
    );
    expect(result.resolvedModel).toBe('gpt-4-turbo');
    expect(result.fallback.used_price_filter).toBe(true);
  });

  it('falls back to the unfiltered pool when nothing is priceable', () => {
    const result = selectMiddlePowerFallback(
      'something', { openai: catalog }, 'openai', 'test',
      { enabled: true, strategy: 'middle_power', isModelPriceable: () => false }
    );
    expect(result).not.toBeNull();
    expect(result.fallback.used_price_filter).toBe(false);
  });

  it('is a no-op when no predicate is supplied', () => {
    const withOut = selectMiddlePowerFallback(
      'something', { openai: catalog }, 'openai', 'test',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(withOut.fallback.used_price_filter).toBe(false);
  });

  it('treats a throwing predicate as priceable rather than failing resolution', () => {
    const result = selectMiddlePowerFallback(
      'something', { openai: catalog }, 'openai', 'test',
      { enabled: true, strategy: 'middle_power', isModelPriceable: () => { throw new Error('boom'); } }
    );
    expect(result).not.toBeNull();
  });
});
