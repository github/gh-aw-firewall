'use strict';

const {
  MAX_PLANNING_REQUEST_BYTES,
  assertPlanningRequestSize,
  getSerializedByteLength,
  toRouteCandidates,
  validateCapabilities,
  validateClassifierOutput,
  validateClassifyResponse,
  validateConversation,
  validateRouteResponse,
} = require('./routing-contract');
const { corpusCase, corpusCases } = require('./fixtures/routing-corpus');

const offeredChoices = [
  { id: 'fast', model: 'github-copilot/router-fast' },
  {
    id: 'reasoning-medium',
    model: 'github-copilot/router-reasoning',
    effort: 'medium',
  },
];

describe('routing contracts', () => {
  it('accepts reviewed capability, classifier-plan, and route shapes', () => {
    const successfulPlanningRecords = corpusCases.filter(testCase =>
      testCase.status === 200 && ['/capabilities', '/classify', '/route'].includes(testCase.path),
    );

    for (const testCase of successfulPlanningRecords) {
      if (testCase.path === '/capabilities') {
        expect(validateCapabilities(
          testCase.response,
          { goal: 'cost', mode: 'auto' },
          { name: 'gh-aw-router', version: '0.1.1' },
        )).toBe(testCase.response);
      } else if (testCase.path === '/classify') {
        expect(validateClassifyResponse(testCase.response, testCase.request.models))
          .toBe(testCase.response);
      } else {
        expect(validateRouteResponse(testCase.response, testCase.request.models))
          .toBe(testCase.response);
      }
    }
  });

  it('requires all fixed profiles for auto and only the exact fixed profile otherwise', () => {
    const capabilities = corpusCase('capabilities').response;
    const withoutRobustCost = {
      ...capabilities,
      routing_profiles: capabilities.routing_profiles.filter(profile =>
        !(profile.goal === 'cost' && profile.mode === 'robust'),
      ),
    };

    expect(() => validateCapabilities(
      withoutRobustCost,
      { goal: 'cost', mode: 'auto' },
    )).toThrow('The router does not provide every required routing profile');
    expect(validateCapabilities(
      withoutRobustCost,
      { goal: 'cost', mode: 'balanced' },
    )).toBe(withoutRobustCost);
  });

  it('rejects extra capability fields and mismatched artifact metadata', () => {
    const capabilities = corpusCase('capabilities').response;

    expect(() => validateCapabilities(
      { ...capabilities, extra: true },
      { goal: 'cost', mode: 'balanced' },
    )).toThrow('The router capabilities response is invalid');
    expect(() => validateCapabilities(
      capabilities,
      { goal: 'cost', mode: 'balanced' },
      { name: 'different-router' },
    )).toThrow('The router service identity does not match the tested artifact');
    expect(() => validateCapabilities(
      capabilities,
      { goal: 'cost', mode: 'balanced' },
      { version: '9.9.9' },
    )).toThrow('The router version does not match the tested artifact');
  });

  it('requires a valid conversation with authored nonblank user text', () => {
    const conversation = [
      { role: 'system', parts: [{ text: 'System context' }] },
      { role: 'user', parts: [{ text: 'Proceed.' }] },
      {
        role: 'assistant',
        parts: [
          { tool_call: { id: 'call-1', name: 'read', input: { path: 'README.md' } } },
          { tool_result: { id: 'call-1', text: 'result', ok: true } },
        ],
      },
    ];

    expect(validateConversation(conversation)).toBe(conversation);
    expect(() => validateConversation([
      { role: 'user', parts: [{ text: ' ' }] },
    ])).toThrow('The routing conversation must contain a nonblank user message');
    expect(() => validateConversation([
      { role: 'user', parts: [{ text: 'Proceed.' }], extra: true },
    ])).toThrow('The routing conversation does not match the router contract');
  });

  it('rejects empty, duplicate, non-offered, and effort-mismatched planner choices', () => {
    expect(() => validateRouteResponse({ ranked_choices: [] }, offeredChoices))
      .toThrow('The router route response is invalid');
    expect(() => validateRouteResponse(
      { ranked_choices: [offeredChoices[0], offeredChoices[0]] },
      offeredChoices,
    )).toThrow('The router route response returned a duplicate choice');
    expect(() => validateClassifyResponse({
      system_prompt: 'Classify',
      prompt: 'Prompt',
      ranked_choices: [{ id: 'other', model: 'github-copilot/router-other' }],
    }, offeredChoices)).toThrow('The router classifier plan returned a choice that was not offered');
    expect(() => validateRouteResponse({
      ranked_choices: [{
        id: 'reasoning-medium',
        model: 'github-copilot/router-reasoning',
        effort: null,
      }],
    }, offeredChoices)).toThrow('The router route response returned a choice that was not offered');
  });

  it('adds trusted context metadata only to route candidates', () => {
    const pool = {
      choices: offeredChoices,
      byId: {
        fast: { contextWindow: 32_000, secret: 'not-forwarded' },
        'reasoning-medium': { contextWindow: undefined, secret: 'not-forwarded' },
      },
    };

    expect(toRouteCandidates(pool)).toEqual([
      { ...offeredChoices[0], context_window: 32_000 },
      offeredChoices[1],
    ]);
  });

  it('allows the exact UTF-8 limit and rejects one byte beyond it', () => {
    const exact = 'é'.repeat((MAX_PLANNING_REQUEST_BYTES - 2) / 2);
    const oneByteOver = `${exact}x`;

    expect(getSerializedByteLength(exact)).toBe(MAX_PLANNING_REQUEST_BYTES);
    expect(() => assertPlanningRequestSize(exact)).not.toThrow();
    expect(getSerializedByteLength(oneByteOver)).toBe(MAX_PLANNING_REQUEST_BYTES + 1);
    expect(() => assertPlanningRequestSize(oneByteOver))
      .toThrow('The serialized routing request exceeds 1048576 bytes');
  });

  it('loads the recorded router corpus', () => {
    expect(corpusCases).toHaveLength(10);
    expect(corpusCase('health')).toMatchObject({ path: '/healthz', status: 204 });
    expect(() => corpusCase('not-recorded')).toThrow('Router corpus case is missing');

    expect(validateClassifierOutput(JSON.stringify({
      labels: { task_type: 'implement', scope: 'multi_file', task_complexity: 'medium' },
      mode: 'balanced',
    }))).toEqual({
      labels: { task_type: 'implement', scope: 'multi_file', task_complexity: 'medium' },
      mode: 'balanced',
    });
    expect(validateClassifierOutput('{')).toBeNull();
    expect(validateClassifierOutput(JSON.stringify({
      labels: { task_type: 'implement', scope: 'multi_file', task_complexity: 'medium' },
      mode: 'balanced',
      extra: true,
    }))).toBeNull();
  });

  it.each(['cost', 'cost-speed'])('accepts the recorded capabilities for %s/auto', (goal) => {
    expect(validateCapabilities(
      corpusCase('capabilities').response,
      { goal, mode: 'auto' },
    )).toBe(corpusCase('capabilities').response);
  });
});
