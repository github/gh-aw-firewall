import type { ModelPolicy } from './model-policy';
import { resolveModel } from './model-resolver';
import type { AvailableModel } from './model-resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    version: '1',
    model: { id: 'gpt-5.2', provider: 'copilot' },
    ...overrides,
  };
}

const GPT52: AvailableModel = { id: 'gpt-5.2', provider: 'copilot', context_window: 200000, cost_tier: 'premium', capabilities: ['tool-use', 'vision'] };
const GPT41: AvailableModel = { id: 'gpt-4.1', provider: 'copilot', context_window: 128000, cost_tier: 'standard', capabilities: ['tool-use'] };
const CLAUDE: AvailableModel = { id: 'claude-sonnet-4-20250514', provider: 'anthropic', context_window: 200000, cost_tier: 'standard', capabilities: ['tool-use', 'vision'] };
const ECONOMY: AvailableModel = { id: 'gpt-4.1-mini', provider: 'copilot', context_window: 128000, cost_tier: 'economy', capabilities: [] };

describe('model-resolver', () => {
  describe('resolveModel — primary', () => {
    it('returns primary when it is available and no constraints', () => {
      const result = resolveModel(makePolicy(), [GPT52]);
      expect(result.source).toBe('primary');
      expect(result.model.id).toBe('gpt-5.2');
    });

    it('returns primary when it satisfies constraints', () => {
      const result = resolveModel(
        makePolicy({
          constraints: { capabilities: ['tool-use'], min_context_window: 100000 },
        }),
        [GPT52]
      );
      expect(result.source).toBe('primary');
      expect(result.model.id).toBe('gpt-5.2');
    });

    it('skips primary when it is not in the available list', () => {
      const result = resolveModel(
        makePolicy({ fallback: [{ id: 'gpt-4.1', provider: 'copilot' }] }),
        [GPT41]
      );
      expect(result.source).toBe('fallback');
      expect(result.model.id).toBe('gpt-4.1');
    });

    it('skips primary when it fails constraint (min_context_window)', () => {
      const policy = makePolicy({
        model: { id: 'gpt-5.2', provider: 'copilot' },
        fallback: [{ id: 'gpt-4.1', provider: 'copilot' }],
        constraints: { min_context_window: 300000 },
      });
      // GPT52 has 200k window — fails; GPT41 also fails (128k)
      expect(() => resolveModel(policy, [GPT52, GPT41])).toThrow();
    });

    it('matches primary by id only when provider is omitted', () => {
      const policy = makePolicy({ model: { id: 'gpt-5.2' } });
      const result = resolveModel(policy, [GPT52]);
      expect(result.source).toBe('primary');
    });
  });

  describe('resolveModel — fallback chain', () => {
    it('returns first satisfying fallback when primary is absent', () => {
      const policy = makePolicy({
        fallback: [
          { id: 'gpt-4.1', provider: 'copilot' },
          { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        ],
      });
      const result = resolveModel(policy, [GPT41, CLAUDE]);
      expect(result.source).toBe('fallback');
      expect(result.fallback_index).toBe(0);
      expect(result.model.id).toBe('gpt-4.1');
    });

    it('skips fallback entries that fail constraints', () => {
      const policy = makePolicy({
        fallback: [
          { id: 'gpt-4.1', provider: 'copilot' },
          { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        ],
        constraints: { capabilities: ['vision'] },
      });
      // GPT41 has no vision; CLAUDE does
      const result = resolveModel(policy, [GPT41, CLAUDE]);
      expect(result.source).toBe('fallback');
      expect(result.fallback_index).toBe(1);
      expect(result.model.id).toBe('claude-sonnet-4-20250514');
    });

    it('skips fallback entries not in available list', () => {
      const policy = makePolicy({
        fallback: [
          { id: 'gpt-4.1', provider: 'copilot' },
          { id: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        ],
      });
      const result = resolveModel(policy, [CLAUDE]);
      expect(result.source).toBe('fallback');
      expect(result.fallback_index).toBe(1);
    });
  });

  describe('resolveModel — auto sentinel', () => {
    it('selects best available model when auto sentinel is reached', () => {
      const policy = makePolicy({
        model: { id: 'nonexistent' },
        fallback: [{ strategy: 'auto' }],
      });
      const result = resolveModel(policy, [GPT41, CLAUDE]);
      expect(result.source).toBe('auto');
      expect(result.model.id).toBe('gpt-4.1');
    });

    it('applies constraints when resolving via auto', () => {
      const policy = makePolicy({
        model: { id: 'nonexistent' },
        fallback: [{ strategy: 'auto' }],
        constraints: { capabilities: ['vision'] },
      });
      // GPT41 lacks vision, CLAUDE has it
      const result = resolveModel(policy, [GPT41, CLAUDE]);
      expect(result.source).toBe('auto');
      expect(result.model.id).toBe('claude-sonnet-4-20250514');
    });

    it('falls through to on_unavailable when auto finds no constrained model', () => {
      const policy = makePolicy({
        model: { id: 'nonexistent' },
        fallback: [{ strategy: 'auto' }],
        constraints: { cost_tier: 'premium' },
        on_unavailable: 'fail',
      });
      // Only economy/standard models available
      expect(() => resolveModel(policy, [GPT41, ECONOMY])).toThrow(
        'No model satisfying policy constraints is available'
      );
    });
  });

  describe('resolveModel — on_unavailable', () => {
    it('throws by default (fail) when no model is found', () => {
      const policy = makePolicy();
      expect(() => resolveModel(policy, [])).toThrow(
        'No model satisfying policy constraints is available'
      );
    });

    it('throws with on_unavailable: "fail"', () => {
      const policy = makePolicy({ on_unavailable: 'fail' });
      expect(() => resolveModel(policy, [])).toThrow(
        'No model satisfying policy constraints is available'
      );
    });

    it('returns best available with on_unavailable: "warn-and-use-best"', () => {
      const policy = makePolicy({
        constraints: { cost_tier: 'premium' },
        on_unavailable: 'warn-and-use-best',
      });
      // Only standard model is available — constraints not satisfied
      const result = resolveModel(policy, [GPT41]);
      expect(result.source).toBe('auto');
      expect(result.model.id).toBe('gpt-4.1');
      expect(result.reason).toMatch(/warn-and-use-best/);
    });

    it('throws when warn-and-use-best has empty available list', () => {
      const policy = makePolicy({ on_unavailable: 'warn-and-use-best' });
      expect(() => resolveModel(policy, [])).toThrow('No models available at all');
    });

    it('throws with on_unavailable: "queue"', () => {
      const policy = makePolicy({ on_unavailable: 'queue' });
      expect(() => resolveModel(policy, [])).toThrow('runtime queuing is not yet supported');
    });
  });

  describe('resolveModel — constraint enforcement', () => {
    it('enforces capabilities constraint', () => {
      const policy = makePolicy({
        model: { id: 'gpt-5.2', provider: 'copilot' },
        constraints: { capabilities: ['vision'] },
        on_unavailable: 'fail',
      });
      // GPT52 has vision — should succeed
      const result = resolveModel(policy, [GPT52]);
      expect(result.source).toBe('primary');
    });

    it('skips model missing required capability', () => {
      const policy = makePolicy({
        model: { id: 'gpt-4.1', provider: 'copilot' },
        constraints: { capabilities: ['vision'] },
        on_unavailable: 'fail',
      });
      // GPT41 lacks vision
      expect(() => resolveModel(policy, [GPT41])).toThrow();
    });

    it('enforces min_context_window constraint', () => {
      const policy = makePolicy({
        model: { id: 'gpt-5.2', provider: 'copilot' },
        constraints: { min_context_window: 128001 },
      });
      // GPT52 has 200k — passes; GPT41 has 128k — fails
      const result = resolveModel(policy, [GPT52]);
      expect(result.source).toBe('primary');

      const policySmall = makePolicy({
        model: { id: 'gpt-4.1', provider: 'copilot' },
        constraints: { min_context_window: 128001 },
        on_unavailable: 'fail',
      });
      expect(() => resolveModel(policySmall, [GPT41])).toThrow();
    });

    it('enforces max_context_window constraint', () => {
      // GPT52 has 200k — fails; GPT41 has 128k — passes
      const policyWithFallback = makePolicy({
        model: { id: 'gpt-5.2', provider: 'copilot' },
        fallback: [{ id: 'gpt-4.1', provider: 'copilot' }],
        constraints: { max_context_window: 150000 },
      });
      const result = resolveModel(policyWithFallback, [GPT52, GPT41]);
      expect(result.model.id).toBe('gpt-4.1');
    });

    it('treats null max_context_window as no upper bound', () => {
      const policy = makePolicy({
        constraints: { max_context_window: null },
      });
      const result = resolveModel(policy, [GPT52]);
      expect(result.source).toBe('primary');
    });

    it('enforces cost_tier constraint', () => {
      const policy = makePolicy({
        model: { id: 'gpt-5.2', provider: 'copilot' },
        fallback: [{ id: 'gpt-4.1-mini', provider: 'copilot' }],
        constraints: { cost_tier: 'economy' },
      });
      const result = resolveModel(policy, [GPT52, ECONOMY]);
      expect(result.model.id).toBe('gpt-4.1-mini');
      expect(result.source).toBe('fallback');
    });
  });

  describe('resolveModel — provider matching', () => {
    it('matches by provider when specified in ModelSpec', () => {
      const copilotGpt = { id: 'gpt-4.1', provider: 'copilot', capabilities: [] };
      const openaiGpt = { id: 'gpt-4.1', provider: 'openai', capabilities: [] };
      const policy = makePolicy({
        model: { id: 'gpt-4.1', provider: 'openai' },
      });
      const result = resolveModel(policy, [copilotGpt, openaiGpt]);
      expect(result.model.provider).toBe('openai');
    });

    it('matches any provider when provider is omitted in ModelSpec', () => {
      const copilotGpt: AvailableModel = { id: 'gpt-4.1', provider: 'copilot' };
      const policy = makePolicy({ model: { id: 'gpt-4.1' } });
      const result = resolveModel(policy, [copilotGpt]);
      expect(result.source).toBe('primary');
    });
  });
});
