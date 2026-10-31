import { validateCopilotModel } from './copilot-model';
import { createEligibilityStore } from '../shared/model-information/eligibility';
import { identity } from '../shared/model-information/identity';

describe('validateCopilotModel', () => {
  const cliScope = { provider: 'copilot', channel: 'copilot-cli' };
  const harness = {
    scope: cliScope, name: 'copilot', scheme: 'semver' as const, minimum: '2.0.0',
    reason: 'Explicit test requirement', provenance: { authority: 'maintained', source: 'fixture' },
  };
  it('uses explicit actual CLI evidence without treating the host as the sandbox', () => {
    const evidence = {
      harnesses: [harness], executionEnvironment: 'container:run',
      observations: [{
        scope: cliScope, name: 'copilot', version: '2.0.0',
        environment: 'container:run', verified: true, actual: true,
      }],
    };
    expect(validateCopilotModel('GPT_5_3_CODEX', evidence))
      .toEqual({ valid: true, resolvedModel: 'gpt-5.3-codex' });
    expect(validateCopilotModel('gpt-5.3-codex', {
      ...evidence, observations: [{ ...evidence.observations[0], environment: 'host' }],
    })).toMatchObject({ valid: false, reason: 'unsupported', message: expect.stringContaining('harness_unverified') });
    expect(validateCopilotModel('gpt-5.3-codex', {
      ...evidence, observations: [{ ...evidence.observations[0], version: '1.9.9' }],
    })).toMatchObject({
      valid: false, reason: 'unsupported',
      message: expect.stringContaining('required semver >=2.0.0; excluded=[]; detected=1.9.9; Explicit test requirement'),
    });
    const failure = validateCopilotModel('gpt-5.3-codex', { ...evidence, observations: [] });
    expect(failure).toMatchObject({
      valid: false,
      message: expect.stringContaining('scope={"provider":"copilot","channel":"copilot-cli"}; environment=container:run'),
    });
  });

  it('keeps API harness requirements out of the CLI and accepts an explicit pinned snapshot', () => {
    expect(validateCopilotModel('gpt-5.3-codex', {
      harnesses: [{ ...harness, scope: { ...cliScope, channel: 'copilot-api' } }],
    })).toEqual({ valid: true, resolvedModel: 'gpt-5.3-codex' });
    const snapshot = createEligibilityStore({
      models: [{ identity: identity('copilot', 'gpt-5.3-codex'), harnesses: [harness] }],
    }).pin();
    expect(validateCopilotModel('gpt-5.3-codex', { snapshot }))
      .toMatchObject({ valid: false, reason: 'unsupported' });
  });

  it('rejects retired aliases with a clear suggestion', () => {
    const result = validateCopilotModel('gpt-5-codex');
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.reason).toBe('retired');
    expect(result.message).toContain("Did you mean 'gpt-5.3-codex'?");
  });

  it('accepts supported canonical models', () => {
    const result = validateCopilotModel('gpt-5.3-codex');
    expect(result).toEqual({ valid: true, resolvedModel: 'gpt-5.3-codex' });
  });

  it('accepts the Copilot auto model', () => {
    const result = validateCopilotModel(' auto ');
    expect(result).toEqual({ valid: true, resolvedModel: 'auto' });
  });

  it.each([
    'gpt-4.5',
    'gpt-5.1',
    'gpt-6-astra',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-sonnet-5',
    'gpt-6-astra',
    'mai-code-1-flash',
  ])('accepts newly supported Copilot allowlist models (%s)', model => {
    const result = validateCopilotModel(model);
    expect(result).toEqual({ valid: true, resolvedModel: model });
  });

  it('accepts empty values after trimming', () => {
    const result = validateCopilotModel('   ');
    expect(result).toEqual({ valid: true, resolvedModel: '' });
  });

  it('normalizes supported models with whitespace and casing', () => {
    const result = validateCopilotModel(' GPT-4.1 ');
    expect(result).toEqual({ valid: true, resolvedModel: 'gpt-4.1' });
  });

  it('normalizes hyphenated version separator to canonical dot form (claude-haiku-4-5 → claude-haiku-4.5)', () => {
    const result = validateCopilotModel('claude-haiku-4-5');
    expect(result).toEqual({ valid: true, resolvedModel: 'claude-haiku-4.5' });
  });

  it('normalizes underscore separator to canonical dot form (claude_haiku_4_5 → claude-haiku-4.5)', () => {
    const result = validateCopilotModel('claude_haiku_4_5');
    expect(result).toEqual({ valid: true, resolvedModel: 'claude-haiku-4.5' });
  });

  it('normalizes uppercase + hyphen separators (CLAUDE-HAIKU-4-5 → claude-haiku-4.5)', () => {
    const result = validateCopilotModel('CLAUDE-HAIKU-4-5');
    expect(result).toEqual({ valid: true, resolvedModel: 'claude-haiku-4.5' });
  });

  it('normalizes hyphenated version separator for other models (claude-sonnet-4-6 → claude-sonnet-4.6)', () => {
    const result = validateCopilotModel('claude-sonnet-4-6');
    expect(result).toEqual({ valid: true, resolvedModel: 'claude-sonnet-4.6' });
  });

  it('accepts canonical dot form without normalization (claude-haiku-4.5 → claude-haiku-4.5)', () => {
    const result = validateCopilotModel('claude-haiku-4.5');
    expect(result).toEqual({ valid: true, resolvedModel: 'claude-haiku-4.5' });
  });

  it('still rejects retired aliases regardless of separator (gpt_5_codex stays retired)', () => {
    const result = validateCopilotModel('gpt_5_codex');
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe('retired');
    expect(result.message).toContain("Did you mean 'gpt-5.3-codex'?");
  });

  it.each([
    [' GPT_5_3_CODEX ', { valid: true, resolvedModel: 'gpt-5.3-codex' }],
    ['CLAUDE-OPUS-4-8', { valid: true, resolvedModel: 'claude-opus-4.8' }],
    ['GPT_5_CODEX', { valid: false, reason: 'retired', replacement: 'gpt-5.3-codex' }],
    ['copilot/gpt-5.3-codex', { valid: false, reason: 'unsupported' }],
    ['gpt-5.3-codex-2026-10-01', { valid: false, reason: 'unsupported' }],
    ['gpt-5.3-codex?deployment=prod', { valid: false, reason: 'unsupported' }],
    ['gpt-5.3-codex-custom', { valid: false, reason: 'unsupported' }],
    ['gpt-5.6-cyber', { valid: false, reason: 'unsupported' }],
    ['gpt-5.5-pro', { valid: false, reason: 'unsupported' }],
  ] as const)('characterizes host exact-model validation for %s', (input, expected) => {
    const result = validateCopilotModel(input);
    expect(result.valid).toBe(expected.valid);
    if (result.valid && expected.valid) {
      expect(result.resolvedModel).toBe(expected.resolvedModel);
    } else if (!result.valid && !expected.valid) {
      expect(result.reason).toBe(expected.reason);
      if ('replacement' in expected) expect(result.message).toContain(expected.replacement);
    }
  });

  it('rejects unsupported models with suggestion when close to known catalog', () => {
    const result = validateCopilotModel('gpt-5.3-codx');
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.reason).toBe('unsupported');
    expect(result.message).toContain('unsupported or unrecognized by this AWF version');
    expect(result.message).toContain("Did you mean 'gpt-5.3-codex'?");
  });

  it.each([
    ['gpt-54-mini', 'gpt-5.4-mini'],
    ['gpt-5.-mini', 'gpt-5.4-mini'],
    ['claude-sonnet-.5', 'claude-sonnet-5'],
    ['claude-sonnet-45', 'claude-sonnet-5'],
    ['gemini-3.5', 'gpt-4.5'],
  ])('preserves legacy insertion-order suggestion ties for %s', (model, suggestion) => {
    expect(validateCopilotModel(model)).toEqual({
      valid: false,
      reason: 'unsupported',
      message: `Error: model '${model}' is unsupported or unrecognized by this AWF version. Did you mean '${suggestion}'?`,
    });
  });

  it.each([
    'claude-opus-5.5', 'claude-sonnet-5.5', 'gemini-3.8-flash',
    'grok-4.5', 'grok-4.6', 'grok-4.7',
  ])('does not activate staged CLI availability for %s', model => {
    expect(validateCopilotModel(model)).toMatchObject({ valid: false, reason: 'unsupported' });
  });

  it.each(['constructor', '__proto__', 'toString'])('does not treat object properties as retired IDs (%s)', model => {
    expect(validateCopilotModel(model)).toMatchObject({ valid: false, reason: 'unsupported' });
  });

  it.each([
    'COPILOT/gpt-5.3-codex', 'openai/gpt-5.3-codex',
    'deployments/prod/gpt-5.3-codex', 'gpt-5.3-codex?',
    'gpt-5-codex?effort=high', 'bad//model',
  ])('keeps CLI syntax restrictions despite shared API resolution for %s', model => {
    expect(validateCopilotModel(model)).toMatchObject({ valid: false, reason: 'unsupported' });
  });

  it('rejects unsupported models without suggestion when no close match exists', () => {
    const result = validateCopilotModel('this-model-does-not-exist-anywhere-12345');
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.reason).toBe('unsupported');
    expect(result.message).toBe(
      "Error: model 'this-model-does-not-exist-anywhere-12345' is unsupported or unrecognized by this AWF version.",
    );
  });
});
