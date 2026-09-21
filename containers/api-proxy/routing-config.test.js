'use strict';

const { parseRoutingConfig } = require('./routing-config');

describe('routing configuration', () => {
  it('keeps an absent value disabled', () => {
    expect(parseRoutingConfig(undefined)).toBeNull();
  });

  it('returns a closed immutable copy', () => {
    const input = {
      objective: { goal: 'cost-speed', mode: 'robust' },
      task: { conversationFile: '/tmp/gh-aw/conversation.json' },
    };

    const result = parseRoutingConfig(JSON.stringify(input));

    expect(result).toEqual(input);
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
});
