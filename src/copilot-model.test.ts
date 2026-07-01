import { validateCopilotModel } from './copilot-model';

describe('validateCopilotModel', () => {
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

  it.each([
    'gpt-4.5',
    'gpt-5.1',
    'claude-fable-5',
    'claude-mythos-5',
    'claude-sonnet-5',
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
