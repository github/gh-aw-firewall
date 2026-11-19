'use strict';

const { parseRoutingConfig } = require('./routing-config');

describe('routing configuration', () => {
  it('keeps an absent value disabled', () => {
    expect(parseRoutingConfig(undefined)).toBeNull();
  });

  it('returns a closed immutable copy', () => {
    const input = {
      objective: { goal: 'cost', mode: 'robust' },
      task: { conversationFile: '/tmp/gh-aw/conversation.json' },
    };

    const result = parseRoutingConfig(JSON.stringify(input));

    expect(result).toEqual({ ...input, provider: 'copilot' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.objective)).toBe(true);
    expect(Object.isFrozen(result.task)).toBe(true);

    const failures = [
      [null, 'AWF_ROUTING_CONFIG must contain JSON'],
      ['', 'AWF_ROUTING_CONFIG must contain JSON'],
      ['{', 'AWF_ROUTING_CONFIG must contain valid JSON'],
      ['[]', 'routing must be an object'],
      [JSON.stringify({ objective: input.objective, task: input.task, extra: true }),
        'routing.extra is not supported'],
      [JSON.stringify({ task: input.task }), 'routing.objective is required'],
      [JSON.stringify({ objective: null, task: input.task }), 'routing.objective must be an object'],
      [JSON.stringify({ objective: { ...input.objective, extra: true }, task: input.task }),
        'routing.objective.extra is not supported'],
      [JSON.stringify({ objective: { goal: input.objective.goal }, task: input.task }),
        'routing.objective.mode is required'],
      [JSON.stringify({ objective: input.objective }), 'routing.task is required'],
      [JSON.stringify({ objective: input.objective, task: [] }), 'routing.task must be an object'],
      [JSON.stringify({ objective: input.objective, task: { ...input.task, extra: true } }),
        'routing.task.extra is not supported'],
      [JSON.stringify({ objective: input.objective, task: {} }),
        'routing.task.conversationFile is required'],
      [JSON.stringify({ objective: { ...input.objective, goal: 'quality' }, task: input.task }),
        'routing.objective.goal is not supported'],
      [JSON.stringify({ objective: { ...input.objective, mode: 'fast' }, task: input.task }),
        'routing.objective.mode is not supported'],
      [JSON.stringify({ objective: input.objective, task: { conversationFile: ' ' } }),
        'routing.task.conversationFile must be a nonblank string'],
    ];

    for (const [raw, message] of failures) {
      expect(() => parseRoutingConfig(raw)).toThrow(message);
    }
  });

  it.each(['auto', 'economy', 'balanced', 'robust'])('preserves cost/%s and rejects cost-speed without aliasing', mode => {
    const input = {
      objective: { goal: 'cost', mode },
      task: { conversationFile: '/tmp/gh-aw/conversation.json' },
    };

    expect(parseRoutingConfig(JSON.stringify(input)).objective).toEqual(input.objective);
    expect(() => parseRoutingConfig(JSON.stringify({
      ...input,
      objective: { goal: 'cost-speed', mode },
    }))).toThrow('routing.objective.goal is not supported');
  });

  it('preserves a distinct non-empty candidate list', () => {
    const input = {
      candidateModels: ['  github-copilot/gpt-5*  '],
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile: '/tmp/gh-aw/conversation.json' },
    };

    const result = parseRoutingConfig(JSON.stringify(input));

    expect(result.candidateModels).toEqual(['github-copilot/gpt-5*']);
    expect(Object.isFrozen(result.candidateModels)).toBe(true);
    expect(() => parseRoutingConfig(JSON.stringify({ ...input, candidateModels: [] })))
      .toThrow('routing.candidateModels must be a non-empty array');
    expect(() => parseRoutingConfig(JSON.stringify({ ...input, candidateModels: ['${{ inputs.model }}'] })))
      .toThrow('routing.candidateModels[0] must be a literal model pattern');
  });

  it('defaults to Copilot and permits only provider-scoped routing slots', () => {
    const base = {
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile: '/tmp/conversation.json' },
    };
    expect(parseRoutingConfig(JSON.stringify(base)).provider).toBe('copilot');
    for (const provider of ['copilot', 'openai', 'anthropic']) {
      expect(parseRoutingConfig(JSON.stringify({ ...base, provider })).provider).toBe(provider);
    }
    expect(() => parseRoutingConfig(JSON.stringify({ ...base, provider: 'gemini' })))
      .toThrow('routing.provider is not supported');
    expect(() => parseRoutingConfig(JSON.stringify({ ...base, provider: null })))
      .toThrow('routing.provider is not supported');
  });

  it('accepts an explicit bounded integer topK without enabling a manual model override', () => {
    const base = { objective: { goal: 'cost', mode: 'balanced' }, task: { conversationFile: '/private/task' } };
    const parse = fields => parseRoutingConfig(JSON.stringify({ ...base, ...fields }));
    expect(parse({})).not.toHaveProperty('topK');
    expect(() => parse({ topK: 3, excludedModels: ['openai/model-a'] })).toThrow('routing.excludedModels is not supported');
    for (const topK of [1, 3, 32]) {
      expect(parse({ topK }).topK).toBe(topK);
    }
    for (const topK of [0, -1, 33, 1.5, '3', null, true]) {
      expect(() => parse({ topK })).toThrow('routing.topK');
    }
  });
});
