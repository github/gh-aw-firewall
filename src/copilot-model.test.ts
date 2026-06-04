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

  it('accepts empty values after trimming', () => {
    const result = validateCopilotModel('   ');
    expect(result).toEqual({ valid: true, resolvedModel: '' });
  });

  it('normalizes supported models with whitespace and casing', () => {
    const result = validateCopilotModel(' GPT-4.1 ');
    expect(result).toEqual({ valid: true, resolvedModel: 'gpt-4.1' });
  });

  it('rejects unsupported models with suggestion when close to known catalog', () => {
    const result = validateCopilotModel('gpt-5.3-codx');
    expect(result.valid).toBe(false);
    if (result.valid) {
      return;
    }
    expect(result.reason).toBe('unsupported');
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
      "Error: model 'this-model-does-not-exist-anywhere-12345' is retired or unsupported.",
    );
  });
});
