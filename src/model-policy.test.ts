import {
  MAX_FALLBACK_DEPTH,
  parseModelPolicy,
  parseModelPolicyFromBase64,
  serializeModelPolicyToBase64,
  validateModelPolicy,
} from './model-policy';

describe('model-policy', () => {
  describe('validateModelPolicy', () => {
    it('accepts a minimal valid policy', () => {
      const errors = validateModelPolicy({ version: '1', model: { id: 'gpt-5.2' } });
      expect(errors).toEqual([]);
    });

    it('accepts a fully populated valid policy', () => {
      const errors = validateModelPolicy({
        $schema:
          'https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/model-policy.v1.json',
        version: '1',
        model: { id: 'gpt-5.2', provider: 'copilot', reasoning_effort: 'medium' },
        fallback: [
          { id: 'gpt-4.1', provider: 'copilot' },
          { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
          { strategy: 'auto' },
        ],
        constraints: {
          capabilities: ['tool-use', 'vision'],
          max_context_window: null,
          min_context_window: 128000,
          cost_tier: 'standard',
        },
        on_unavailable: 'fail',
        audit: { log_selection: true, log_fallback_reason: true },
      });
      expect(errors).toEqual([]);
    });

    it('rejects non-object root', () => {
      expect(validateModelPolicy(null)).toEqual(['policy root must be an object']);
      expect(validateModelPolicy('string')).toEqual(['policy root must be an object']);
      expect(validateModelPolicy(42)).toEqual(['policy root must be an object']);
      expect(validateModelPolicy([])).toEqual(['policy root must be an object']);
    });

    it('rejects missing version', () => {
      const errors = validateModelPolicy({ model: { id: 'gpt-5.2' } });
      expect(errors).toContain('policy.version must be "1"');
    });

    it('rejects wrong version value', () => {
      const errors = validateModelPolicy({ version: '2', model: { id: 'gpt-5.2' } });
      expect(errors).toContain('policy.version must be "1"');
    });

    it('rejects numeric version', () => {
      const errors = validateModelPolicy({ version: 1, model: { id: 'gpt-5.2' } });
      expect(errors).toContain('policy.version must be "1"');
    });

    it('rejects missing model', () => {
      const errors = validateModelPolicy({ version: '1' });
      expect(errors).toContain('policy.model is required');
    });

    it('rejects non-object model', () => {
      const errors = validateModelPolicy({ version: '1', model: 'gpt-5.2' });
      expect(errors).toContain('policy.model must be an object');
    });

    it('rejects empty model id', () => {
      const errors = validateModelPolicy({ version: '1', model: { id: '' } });
      expect(errors).toContain('policy.model.id must be a non-empty string');
    });

    it('rejects whitespace-only model id', () => {
      const errors = validateModelPolicy({ version: '1', model: { id: '   ' } });
      expect(errors).toContain('policy.model.id must be a non-empty string');
    });

    it('rejects invalid model provider', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2', provider: 'google' },
      });
      expect(errors).toContain('policy.model.provider must be one of: copilot, anthropic, openai, custom');
    });

    it('rejects invalid model reasoning_effort', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2', reasoning_effort: 'turbo' },
      });
      expect(errors).toContain(
        'policy.model.reasoning_effort must be one of: low, medium, high'
      );
    });

    it('rejects unknown keys in model', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2', unknown_field: true },
      });
      expect(errors).toContain('policy.model.unknown_field is not supported');
    });

    it('rejects non-string $schema', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        $schema: 123,
      });
      expect(errors).toContain('policy.$schema must be a string');
    });

    it('rejects unknown root keys', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        extra: true,
      });
      expect(errors).toContain('policy.extra is not supported');
    });

    // ---- fallback ----

    it('rejects non-array fallback', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: 'gpt-4.1',
      });
      expect(errors).toContain('policy.fallback must be an array');
    });

    it(`rejects fallback exceeding ${MAX_FALLBACK_DEPTH} entries`, () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: [
          { id: 'a' },
          { id: 'b' },
          { id: 'c' },
          { id: 'd' },
          { id: 'e' },
          { id: 'f' },
        ],
      });
      expect(errors).toContain(`policy.fallback must not exceed ${MAX_FALLBACK_DEPTH} entries`);
    });

    it('rejects invalid strategy value in fallback entry', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: [{ strategy: 'best' }],
      });
      expect(errors).toContain('policy.fallback[0].strategy must be "auto"');
    });

    it('rejects non-object fallback entry', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: ['gpt-4.1'],
      });
      expect(errors).toContain('policy.fallback[0] must be an object');
    });

    it('rejects fallback entry with unknown keys', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: [{ strategy: 'auto', extra: true }],
      });
      expect(errors).toContain('policy.fallback[0].extra is not supported');
    });

    it('rejects invalid provider in fallback entry', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: [{ id: 'gpt-4.1', provider: 'unknown' }],
      });
      expect(errors).toContain(
        'policy.fallback[0].provider must be one of: copilot, anthropic, openai, custom'
      );
    });

    it('accepts "auto" sentinel fallback entry', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        fallback: [{ strategy: 'auto' }],
      });
      expect(errors).toEqual([]);
    });

    // ---- constraints ----

    it('rejects non-object constraints', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: 'fast',
      });
      expect(errors).toContain('policy.constraints must be an object');
    });

    it('rejects invalid capability in constraints', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { capabilities: ['tool-use', 'flying'] },
      });
      expect(errors).toContain(
        'policy.constraints.capabilities must be an array of: tool-use, vision, code-execution, image-generation'
      );
    });

    it('rejects non-array capabilities', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { capabilities: 'tool-use' },
      });
      expect(errors).toContain(
        'policy.constraints.capabilities must be an array of: tool-use, vision, code-execution, image-generation'
      );
    });

    it('accepts null max_context_window', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { max_context_window: null },
      });
      expect(errors).toEqual([]);
    });

    it('rejects non-integer max_context_window', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { max_context_window: 1.5 },
      });
      expect(errors).toContain('policy.constraints.max_context_window must be a positive integer or null');
    });

    it('rejects zero max_context_window', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { max_context_window: 0 },
      });
      expect(errors).toContain('policy.constraints.max_context_window must be a positive integer or null');
    });

    it('rejects non-integer min_context_window', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { min_context_window: 'large' },
      });
      expect(errors).toContain('policy.constraints.min_context_window must be a positive integer');
    });

    it('rejects invalid cost_tier', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { cost_tier: 'ultra' },
      });
      expect(errors).toContain('policy.constraints.cost_tier must be one of: economy, standard, premium');
    });

    it('rejects unknown keys in constraints', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        constraints: { max_tokens: 1000 },
      });
      expect(errors).toContain('policy.constraints.max_tokens is not supported');
    });

    // ---- on_unavailable ----

    it('rejects invalid on_unavailable value', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        on_unavailable: 'retry',
      });
      expect(errors).toContain(
        'policy.on_unavailable must be one of: fail, warn-and-use-best, queue'
      );
    });

    it('accepts all valid on_unavailable values', () => {
      for (const value of ['fail', 'warn-and-use-best', 'queue']) {
        const errors = validateModelPolicy({
          version: '1',
          model: { id: 'gpt-5.2' },
          on_unavailable: value,
        });
        expect(errors).toEqual([]);
      }
    });

    // ---- audit ----

    it('rejects non-object audit', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        audit: true,
      });
      expect(errors).toContain('policy.audit must be an object');
    });

    it('rejects non-boolean audit.log_selection', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        audit: { log_selection: 'yes' },
      });
      expect(errors).toContain('policy.audit.log_selection must be a boolean');
    });

    it('rejects non-boolean audit.log_fallback_reason', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        audit: { log_fallback_reason: 1 },
      });
      expect(errors).toContain('policy.audit.log_fallback_reason must be a boolean');
    });

    it('rejects unknown keys in audit', () => {
      const errors = validateModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2' },
        audit: { log_selection: true, trace_id: 'abc' },
      });
      expect(errors).toContain('policy.audit.trace_id is not supported');
    });
  });

  // ---- parseModelPolicy ----

  describe('parseModelPolicy', () => {
    it('returns typed policy for a valid document', () => {
      const policy = parseModelPolicy({
        version: '1',
        model: { id: 'gpt-5.2', provider: 'copilot' },
      });
      expect(policy.version).toBe('1');
      expect(policy.model.id).toBe('gpt-5.2');
    });

    it('throws on invalid document', () => {
      expect(() => parseModelPolicy({ version: '2', model: { id: 'x' } })).toThrow(
        'Invalid model policy'
      );
    });
  });

  // ---- base64 round-trip ----

  describe('parseModelPolicyFromBase64 / serializeModelPolicyToBase64', () => {
    it('round-trips a valid policy through base64', () => {
      const original = {
        version: '1' as const,
        model: { id: 'gpt-5.2', provider: 'copilot' as const },
        fallback: [{ strategy: 'auto' as const }],
      };
      const encoded = serializeModelPolicyToBase64(original);
      const decoded = parseModelPolicyFromBase64(encoded);
      expect(decoded.version).toBe('1');
      expect(decoded.model.id).toBe('gpt-5.2');
      expect(decoded.fallback).toEqual([{ strategy: 'auto' }]);
    });

    it('throws on non-JSON base64 payload', () => {
      const bad = Buffer.from('not-json', 'utf-8').toString('base64');
      expect(() => parseModelPolicyFromBase64(bad)).toThrow(
        'Failed to parse model policy JSON'
      );
    });

    it('throws on valid JSON that fails policy validation', () => {
      const bad = Buffer.from(JSON.stringify({ version: '9' }), 'utf-8').toString('base64');
      expect(() => parseModelPolicyFromBase64(bad)).toThrow('Invalid model policy');
    });
  });
});
