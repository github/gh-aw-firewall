'use strict';

// Reset module registry between tests so env-var-based constants are re-evaluated.
beforeEach(() => {
  jest.resetModules();
  delete process.env.AWF_ALLOWED_MODELS;
  delete process.env.AWF_DISALLOWED_MODELS;
});

afterEach(() => {
  delete process.env.AWF_ALLOWED_MODELS;
  delete process.env.AWF_DISALLOWED_MODELS;
});

// Helper: load a fresh instance of the guard with the current env vars.
function loadGuard() {
  return require('./model-policy-guard');
}

describe('parseModelPatterns', () => {
  it('should return null for an empty string', () => {
    const { parseModelPatterns } = loadGuard();
    expect(parseModelPatterns('')).toBeNull();
    expect(parseModelPatterns('  ')).toBeNull();
    expect(parseModelPatterns(null)).toBeNull();
    expect(parseModelPatterns(undefined)).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const { parseModelPatterns } = loadGuard();
    expect(parseModelPatterns('not-json')).toBeNull();
    expect(parseModelPatterns('{}')).toBeNull();
    expect(parseModelPatterns('"string"')).toBeNull();
  });

  it('should return null for an empty array', () => {
    const { parseModelPatterns } = loadGuard();
    expect(parseModelPatterns('[]')).toBeNull();
  });

  it('should return null for arrays with non-string items', () => {
    const { parseModelPatterns } = loadGuard();
    expect(parseModelPatterns('[1, 2]')).toBeNull();
  });

  it('should return the parsed array for a valid JSON array of strings', () => {
    const { parseModelPatterns } = loadGuard();
    expect(parseModelPatterns('["*opus*", "gpt-5*"]')).toEqual(['*opus*', 'gpt-5*']);
  });

  it('should filter out empty strings', () => {
    const { parseModelPatterns } = loadGuard();
    expect(parseModelPatterns('["*opus*", "", "  "]')).toEqual(['*opus*']);
  });
});

describe('isModelPermittedByPolicy', () => {
  it('should permit all models when no policy is configured', () => {
    const { isModelPermittedByPolicy } = loadGuard();
    expect(isModelPermittedByPolicy('claude-opus-4.5', null, null)).toBe(true);
    expect(isModelPermittedByPolicy('gpt-5-codex', null, null)).toBe(true);
  });

  it('should reject models matching a disallowed pattern', () => {
    const { isModelPermittedByPolicy } = loadGuard();
    const disallowed = ['*opus*'];
    expect(isModelPermittedByPolicy('claude-opus-4.5', null, disallowed)).toBe(false);
    expect(isModelPermittedByPolicy('claude-sonnet-4.6', null, disallowed)).toBe(true);
  });

  it('should reject models not matching an allowed pattern', () => {
    const { isModelPermittedByPolicy } = loadGuard();
    const allowed = ['*sonnet*', '*haiku*'];
    expect(isModelPermittedByPolicy('claude-sonnet-4.6', allowed, null)).toBe(true);
    expect(isModelPermittedByPolicy('claude-haiku-3-5', allowed, null)).toBe(true);
    expect(isModelPermittedByPolicy('claude-opus-4.5', allowed, null)).toBe(false);
    expect(isModelPermittedByPolicy('gpt-5-codex', allowed, null)).toBe(false);
  });

  it('should reject models in disallowed list even if also in allowed list', () => {
    const { isModelPermittedByPolicy } = loadGuard();
    const allowed = ['*sonnet*'];
    const disallowed = ['*sonnet*'];
    expect(isModelPermittedByPolicy('claude-sonnet-4.6', allowed, disallowed)).toBe(false);
  });

  it('should be case-insensitive', () => {
    const { isModelPermittedByPolicy } = loadGuard();
    expect(isModelPermittedByPolicy('Claude-Sonnet-4.6', ['*sonnet*'], null)).toBe(true);
    expect(isModelPermittedByPolicy('CLAUDE-OPUS-4.5', null, ['*opus*'])).toBe(false);
  });

  it('should permit models when allowed list is empty/null', () => {
    const { isModelPermittedByPolicy } = loadGuard();
    expect(isModelPermittedByPolicy('any-model', null, null)).toBe(true);
  });
});

describe('getModelPolicyBlockState', () => {
  describe('no policy configured', () => {
    it('should return null for any model', () => {
      const guard = loadGuard();
      expect(guard.getModelPolicyBlockState('claude-opus-4.5')).toBeNull();
      expect(guard.getModelPolicyBlockState('gpt-5-codex')).toBeNull();
      expect(guard.getModelPolicyBlockState(null)).toBeNull();
    });
  });

  describe('disallowedModels only', () => {
    beforeEach(() => {
      process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['*opus*']);
    });

    it('should return block state for a disallowed model', () => {
      const guard = loadGuard();
      const result = guard.getModelPolicyBlockState('claude-opus-4.5');
      expect(result).not.toBeNull();
      expect(result.model).toBe('claude-opus-4.5');
      expect(result.reason).toBe('disallowed');
    });

    it('should return null for a non-disallowed model', () => {
      const guard = loadGuard();
      expect(guard.getModelPolicyBlockState('claude-sonnet-4.6')).toBeNull();
    });

    it('should handle multiple disallowed patterns', () => {
      process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['*opus*', 'gpt-5*']);
      const guard = loadGuard();
      expect(guard.getModelPolicyBlockState('claude-opus-4.5')).not.toBeNull();
      expect(guard.getModelPolicyBlockState('gpt-5-codex')).not.toBeNull();
      expect(guard.getModelPolicyBlockState('claude-sonnet-4.6')).toBeNull();
    });
  });

  describe('allowedModels only', () => {
    beforeEach(() => {
      process.env.AWF_ALLOWED_MODELS = JSON.stringify(['*sonnet*', '*haiku*']);
    });

    it('should return null for an allowed model', () => {
      const guard = loadGuard();
      expect(guard.getModelPolicyBlockState('claude-sonnet-4.6')).toBeNull();
      expect(guard.getModelPolicyBlockState('claude-haiku-3-5')).toBeNull();
    });

    it('should return block state for a model not in the allowed list', () => {
      const guard = loadGuard();
      const result = guard.getModelPolicyBlockState('claude-opus-4.5');
      expect(result).not.toBeNull();
      expect(result.model).toBe('claude-opus-4.5');
      expect(result.reason).toBe('not_allowed');
    });

    it('should return null for null model', () => {
      const guard = loadGuard();
      expect(guard.getModelPolicyBlockState(null)).toBeNull();
    });
  });

  describe('both allowedModels and disallowedModels', () => {
    beforeEach(() => {
      process.env.AWF_ALLOWED_MODELS = JSON.stringify(['*claude*']);
      process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['*opus*']);
    });

    it('should block a model in the disallowed list even if it matches allowed', () => {
      const guard = loadGuard();
      const result = guard.getModelPolicyBlockState('claude-opus-4.5');
      expect(result).not.toBeNull();
      expect(result.reason).toBe('disallowed');
    });

    it('should block a model not in the allowed list', () => {
      const guard = loadGuard();
      const result = guard.getModelPolicyBlockState('gpt-5-codex');
      expect(result).not.toBeNull();
      expect(result.reason).toBe('not_allowed');
    });

    it('should allow a model that matches allowed and does not match disallowed', () => {
      const guard = loadGuard();
      expect(guard.getModelPolicyBlockState('claude-sonnet-4.6')).toBeNull();
    });
  });
});

describe('buildModelPolicyError', () => {
  it('should build a disallowed error message', () => {
    const { buildModelPolicyError } = loadGuard();
    const result = buildModelPolicyError({ model: 'claude-opus-4.5', reason: 'disallowed' });
    expect(result.error.type).toBe('model_policy_violation');
    expect(result.error.model).toBe('claude-opus-4.5');
    expect(result.error.reason).toBe('disallowed');
    expect(result.error.message).toContain('explicitly disallowed');
  });

  it('should build a not_allowed error message', () => {
    const { buildModelPolicyError } = loadGuard();
    const result = buildModelPolicyError({ model: 'gpt-5-codex', reason: 'not_allowed' });
    expect(result.error.type).toBe('model_policy_violation');
    expect(result.error.model).toBe('gpt-5-codex');
    expect(result.error.reason).toBe('not_allowed');
    expect(result.error.message).toContain('allowed models policy');
  });
});
